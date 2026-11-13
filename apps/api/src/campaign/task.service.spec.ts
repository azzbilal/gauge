import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CheckMethod, Prisma, Role, TaskStatus, VerifySubjectType } from '@prisma/client';
import { AuthUser } from '../auth/auth.decorators';
import { CampaignService } from './campaign.service';
import { TaskService } from './task.service';

// A gold task must be indistinguishable from a normal task to whoever reads it
// (docs/pipeline.md §3). Gold reaches a reviewer only as a clone written for them;
// these tests drive the service against an in-memory Prisma.

const created = new Date('2026-11-01T10:00:00Z');
const reviewedAt = new Date('2026-11-02T09:30:00Z');
const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);

function user(expertId: string, role: Role = Role.REVIEWER): AuthUser {
  return { id: `u-${expertId}`, name: expertId, email: `${expertId}@x`, role, expertId };
}

/** New reviewers: a gold review is owed in their first block, so their first fetch clones. */
const dueNow = (n: number) => Array.from({ length: n }, (_, i) => `rev${i}`);
/** A reviewer whose current block already had its gold review (on a gold task, pre-clones). */
function quiet(db: { tasks: Row[] }, expertId = 'quiet'): AuthUser {
  const g0 = db.tasks.find((t) => t.id === 'g0') as Row;
  g0.taskReviews.push(review(`rq-${expertId}`, 'g0', expertId));
  return user(expertId);
}
/** cuid shape, and the time its timestamp block encodes. */
const CUID = /^c[0-9a-z]{24}$/;
const cuidTime = (id: string) => parseInt(id.slice(1, 9), 36);

type Review = {
  id: string;
  taskId: string;
  reviewerId: string;
  reviewerExpertId: string | null;
  scores: unknown;
  accepted: boolean;
  createdAt: Date;
};

function review(id: string, taskId: string, expertId: string, accepted = true): Review {
  return {
    id,
    taskId,
    reviewerId: expertId,
    reviewerExpertId: expertId,
    scores: { verifiable: 5 },
    accepted,
    createdAt: reviewedAt,
  };
}

function task(
  id: string,
  opts: {
    gold: boolean;
    status?: TaskStatus;
    reviews?: Review[];
    createdAt?: Date;
    campaignId?: string;
    authorId?: string;
  },
) {
  const campaignId = opts.campaignId ?? 'c1';
  const authorId = opts.authorId ?? (opts.gold ? 'admin' : 'author');
  return {
    id,
    campaignId,
    authorId,
    prompt: `prompt ${id}`,
    spec: null as string | null,
    reference: null as string | null,
    status: opts.status ?? TaskStatus.SUBMITTED,
    isGold: opts.gold,
    goldExpectedAccept: opts.gold ? false : (null as boolean | null),
    goldSourceId: null as string | null,
    goldForExpertId: null as string | null,
    goldOpenFor: null as string | null,
    createdAt: opts.createdAt ?? created,
    updatedAt: opts.createdAt ?? created,
    campaign: { id: campaignId, name: campaignId.toUpperCase() },
    author: { id: authorId, name: authorId.toUpperCase() },
    taskReviews: opts.reviews ?? [],
  };
}
type Row = ReturnType<typeof task>;

type Where = Record<string, unknown> & { OR?: Where[] };
/** Enough of Prisma's where semantics for the filters the service and campaign list use. */
function matches(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) =>
    key === 'OR' ? (value as Where[]).some((w) => matches(row, w)) : row[key] === value,
  );
}

/** An in-memory Prisma: tasks with their reviews, Layer 2 rows, events. */
function fakeDb(rows: Row[]) {
  let seq = 0;
  let clock = at(10_000).getTime();
  const tasks = rows.map((r) => ({ ...r, taskReviews: [...r.taskReviews] }));
  const layer2 = {
    requirement: [] as Array<Record<string, unknown>>,
    rubricItem: [] as Array<Record<string, unknown>>,
    lintFinding: [] as Array<Record<string, unknown>>,
    verifierRun: [] as Array<Record<string, unknown>>,
    probeRun: [] as Array<Record<string, unknown>>,
  };
  const events: Array<Record<string, unknown>> = [];
  const byId = (id: string) => tasks.find((t) => t.id === id) ?? null;
  const copy = (t: Row) => ({ ...t, taskReviews: [...t.taskReviews] });

  const table = (name: keyof typeof layer2) => ({
    findMany: async ({ where }: { where?: Where } = {}) =>
      layer2[name].filter((r) => matches(r, where)),
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) {
        layer2[name].push({ id: `${name}-${++seq}`, createdAt: new Date(clock++), ...d });
      }
      return { count: data.length };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${name}-${++seq}`, createdAt: new Date(clock++), ...data };
      layer2[name].push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = layer2[name].length;
      layer2[name] = layer2[name].filter((r) => !matches(r, where));
      return { count: before - layer2[name].length };
    },
  });

  const prisma = {
    task: {
      findMany: async ({ where }: { where?: Where } = {}) =>
        tasks
          .filter((t) => matches(t, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(copy),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const t = byId(where.id);
        return t ? copy(t) : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const t = byId(where.id);
        if (!t) throw new Error('not found');
        return copy(t);
      },
      create: async ({ data }: { data: Partial<Row> & { campaignId: string; authorId: string } }) => {
        const clash =
          (data.goldOpenFor && tasks.some((t) => t.goldOpenFor === data.goldOpenFor)) ||
          (data.goldSourceId &&
            tasks.some(
              (t) =>
                t.goldSourceId === data.goldSourceId && t.goldForExpertId === data.goldForExpertId,
            ));
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        // Like Prisma: a supplied id or createdAt is kept, otherwise the default applies.
        const now = new Date(clock++);
        const row: Row = {
          ...task(`ck${(++seq).toString(36).padStart(6, '0')}`, { gold: !!data.isGold }),
          ...data,
          createdAt: data.createdAt ?? now,
          updatedAt: now,
          campaign: { id: data.campaignId, name: data.campaignId.toUpperCase() },
          author: { id: data.authorId, name: data.authorId.toUpperCase() },
          taskReviews: [],
        } as Row;
        tasks.push(row);
        return copy(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const t = byId(where.id) as Row;
        Object.assign(t, data);
        return copy(t);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = tasks.findIndex((t) => t.id === where.id);
        return tasks.splice(i, 1)[0];
      },
    },
    taskReview: {
      create: async ({ data }: { data: Omit<Review, 'id' | 'createdAt'> }) => {
        const t = byId(data.taskId) as Row;
        if (t.taskReviews.some((r) => r.reviewerExpertId === data.reviewerExpertId)) {
          throw new Error('unique (taskId, reviewerExpertId)');
        }
        const r: Review = { id: `rv${++seq}`, createdAt: new Date(clock++), ...data };
        t.taskReviews.push(r);
        return r;
      },
      // The shape calibration() selects: each review with its task's gold fields.
      findMany: async () =>
        tasks.flatMap((t) =>
          t.taskReviews
            .filter((r) => r.reviewerExpertId !== null)
            .map((r) => {
              const source = t.goldSourceId ? byId(t.goldSourceId) : null;
              return {
                reviewerExpertId: r.reviewerExpertId,
                accepted: r.accepted,
                reviewer: { name: r.reviewerExpertId },
                task: {
                  isGold: t.isGold,
                  goldExpectedAccept: t.goldExpectedAccept,
                  goldSource: source ? { goldExpectedAccept: source.goldExpectedAccept } : null,
                },
              };
            }),
        ),
    },
    requirement: table('requirement'),
    rubricItem: table('rubricItem'),
    lintFinding: table('lintFinding'),
    verifierRun: table('verifierRun'),
    probeRun: table('probeRun'),
    reviewDecision: { findMany: async () => [], findFirst: async () => null },
    event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
    campaign: {
      findMany: async (args: {
        include: { _count: { select: { tasks: { where: Where } } } };
      }) =>
        ['c1', 'c2'].map((id) => ({
          id,
          _count: {
            tasks: tasks.filter(
              (t) => t.campaignId === id && matches(t, args.include._count.select.tasks.where),
            ).length,
          },
        })),
    },
    $queryRaw: async (_: TemplateStringsArray, id: string) =>
      byId(id) ? [{ id }] : [],
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  return {
    prisma,
    tasks,
    layer2,
    events,
    service: new TaskService(prisma as never, {} as never),
    campaigns: new CampaignService(prisma as never),
  };
}

const ids = (views: unknown[]) => (views as Array<{ id: string }>).map((v) => v.id);
const scores = {
  verifiable: 5,
  unambiguous: 5,
  correct_reference: 5,
  complete_constraints: 5,
  difficulty: 5,
};

/** Everything a client can see, with the ids and times that differ between two tasks removed. */
function shape(view: Record<string, unknown>) {
  const { id: _id, createdAt: _c, prompt: _p, ...rest } = view;
  void [_id, _c, _p];
  return JSON.parse(JSON.stringify(rest));
}

// A backlog in two campaigns: regular tasks, and gold tasks the admin wrote.
const backlog = () => [
  ...Array.from({ length: 8 }, (_, i) =>
    task(`n${i}`, {
      gold: false,
      createdAt: at(i),
      campaignId: i % 2 ? 'c2' : 'c1',
      authorId: i % 3 ? 'ann' : 'ben',
    }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    task(`g${i}`, { gold: true, createdAt: at(30 + i), campaignId: i % 2 ? 'c2' : 'c1' }),
  ),
];
const goldIds = ['g0', 'g1', 'g2', 'g3'];
/** The ids in a view that are not in the seeded backlog: the viewer's gold clone, if any. */
const fresh = (views: unknown[]) =>
  views
    .map((v) => (typeof v === 'string' ? v : (v as { id: string }).id))
    .filter((id) => !/^[ng]\d$/.test(id));

describe('gold clone: written for one reviewer when gold falls due', () => {
  it('appears as a task of its own, only to that reviewer', async () => {
    const db = fakeDb(backlog());
    const [rita, sam] = dueNow(2).map((r) => user(r));
    const list = await db.service.list(rita);
    const [cloneId] = fresh(list);
    expect(fresh(list)).toHaveLength(1);
    const clone = db.tasks.find((t) => t.id === cloneId) as Row;
    const source = db.tasks.find((t) => t.id === clone.goldSourceId) as Row;
    expect(goldIds).toContain(source.id);
    expect(clone.goldForExpertId).toBe(rita.expertId);
    // Nobody else sees it; no gold source is shown to a reviewer.
    expect(ids(await db.service.list(sam))).not.toContain(cloneId);
    expect(ids(list).filter((id) => goldIds.includes(id))).toEqual([]);
  });

  it('is dated among the campaign\'s real tasks, not at the request, and its id agrees', async () => {
    // The fake clock stands at at(10_000) when the request runs; real tasks are at(0..7).
    for (let trial = 0; trial < 20; trial++) {
      const db = fakeDb(backlog());
      const [rita] = dueNow(1).map((r) => user(`${r}-${trial}`));
      const list = await db.service.list(rita);
      const [cloneId] = fresh(list);
      const clone = db.tasks.find((t) => t.id === cloneId) as Row;
      const real = db.tasks
        .filter((t) => !t.isGold && t.campaignId === clone.campaignId)
        .map((t) => t.createdAt.getTime());
      expect(clone.createdAt.getTime()).toBeGreaterThanOrEqual(Math.min(...real));
      expect(clone.createdAt.getTime()).toBeLessThanOrEqual(Math.max(...real));
      // A cuid whose timestamp is that same backdated time.
      expect(cloneId).toMatch(CUID);
      expect(cuidTime(cloneId)).toBe(clone.createdAt.getTime());
      // So it does not head the newest-first list as a just-written row would.
      expect(ids(list)[0]).not.toBe(cloneId);
    }
  });

  it('writes no clone when no gold is due, and never more than one open clone', async () => {
    const db = fakeDb(backlog());
    expect(fresh(await db.service.list(quiet(db)))).toEqual([]);
    const [rita] = dueNow(1).map((r) => user(r));
    for (let i = 0; i < 3; i++) await db.service.list(rita, undefined, i % 2 === 0);
    expect(db.tasks.filter((t) => t.goldForExpertId === rita.expertId)).toHaveLength(1);
  });

  it('writes one clone when two requests race', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const [a, b] = await Promise.all([
      db.service.list(rita),
      db.service.list(rita, undefined, true),
    ]);
    expect(db.tasks.filter((t) => t.goldForExpertId === rita.expertId)).toHaveLength(1);
    expect(fresh(a)).toEqual(fresh(b));
  });

  it('looks exactly like an unreviewed normal task, with no gold marker', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const [cloneId] = fresh(await db.service.list(rita));
    const clone = (await db.service.get(cloneId, rita)) as Record<string, unknown>;
    const peer = db.tasks.find((t) => !t.isGold && t.campaignId === clone.campaignId) as Row;
    const normal = (await db.service.get(peer.id, rita)) as Record<string, unknown>;
    expect(shape(clone)).toEqual(shape(normal));
    for (const key of ['isGold', 'goldExpectedAccept', 'goldSourceId', 'goldForExpertId', 'updatedAt']) {
      expect(clone).not.toHaveProperty(key);
    }
  });

  it('keeps its place against its neighbours while the reviewer reviews other tasks', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const first = ids(await db.service.list(rita, undefined, true));
    const [cloneId] = fresh(first);
    expect(cloneId).toBeDefined();
    const reviewed: string[] = [];
    for (const id of first.filter((x) => x !== cloneId).slice(0, 3)) {
      await db.service.review(id, { scores }, rita);
      reviewed.push(id);
      const now = ids(await db.service.list(rita, undefined, true));
      // The same rows in the same order, less the ones reviewed: nothing moved.
      expect(now).toEqual(first.filter((x) => !reviewed.includes(x)));
    }
  });

  it('carries its own verification, with ids that do not point back at the gold', async () => {
    const db = fakeDb(backlog());
    db.layer2.requirement.push({
      id: 'req-src',
      taskId: 'g0',
      text: 'width of 60 mm',
      createdAt: at(30),
    });
    db.layer2.rubricItem.push({
      id: 'ri-src',
      taskId: 'g0',
      requirementId: 'req-src',
      text: 'correct_reference: ...',
      checkMethod: CheckMethod.MACHINE,
      weight: 1,
      createdAt: at(30),
    });
    db.layer2.lintFinding.push({
      id: 'lf-src',
      taskId: 'g0',
      rule: 'vague',
      severity: 'warning',
      detail: 'req-src is vague',
      resolved: false,
      createdAt: at(30),
    });
    db.layer2.verifierRun.push({
      id: 'vr-src',
      taskId: 'g0',
      subjectType: VerifySubjectType.REFERENCE_SOLUTION,
      subjectId: 'g0',
      verifierVersion: 'v',
      results: [{ rubric_item_id: 'ri-src', requirement_id: 'req-src', pass: true }],
      passed: true,
      createdAt: at(30),
    });
    // Only g0 is gold, so the clone is of g0.
    db.tasks.splice(0, db.tasks.length, ...db.tasks.filter((t) => !t.isGold || t.id === 'g0'));
    const [rita] = dueNow(1).map((r) => user(r));
    const [cloneId] = fresh(await db.service.list(rita));
    const v = await db.service.verification(cloneId, rita);
    expect(v.taskId).toBe(cloneId);
    expect(v.lintFindings).toHaveLength(1);
    expect(v.verifierRuns).toHaveLength(1);
    const text = JSON.stringify(v);
    for (const leak of ['g0', 'req-src', 'ri-src', 'lf-src', 'vr-src']) {
      expect(text).not.toContain(leak);
    }
    expect(v.verifierRuns[0]).toMatchObject({ taskId: cloneId, subjectId: cloneId });
    // Written with the clone, at its backdated time (the source's rows are at its createdAt),
    // with ids that carry that time too: nothing here dates from the request.
    const cloneAt = (db.tasks.find((t) => t.id === cloneId) as Row).createdAt.getTime();
    for (const row of [...v.lintFindings, ...v.verifierRuns] as Array<{ id: string; createdAt: Date }>) {
      expect(row.createdAt.getTime()).toBe(cloneAt);
      expect(row.id).toMatch(CUID);
      expect(cuidTime(row.id)).toBe(cloneAt);
    }
  });
});

describe('gold clone: reviewed like any task, and scored on the gold', () => {
  it('stores the review on the clone, which stays in the list as a reviewed task', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const [cloneId] = fresh(await db.service.list(rita));
    const sourceId = db.tasks.find((t) => t.id === cloneId)?.goldSourceId as string;
    const countsBefore = await db.campaigns.list(rita);
    const listBefore = ids(await db.service.list(rita));

    const res = await db.service.review(cloneId, { scores }, rita);
    expect(res).toMatchObject({ taskId: cloneId, taskStatus: TaskStatus.IN_REVIEW });
    expect(JSON.stringify(res)).not.toContain(sourceId);

    const source = db.tasks.find((t) => t.id === sourceId) as Row;
    expect(source.taskReviews).toEqual([]);
    expect(source.status).toBe(TaskStatus.SUBMITTED); // gold never changes status
    const clone = db.tasks.find((t) => t.id === cloneId) as Row;
    expect(clone.taskReviews.map((r) => r.reviewerExpertId)).toEqual([rita.expertId]);
    expect(clone.goldOpenFor).toBeNull();

    // Still there, read as a normal task after one review; out of the queue; same counts.
    const view = (await db.service.get(cloneId, rita)) as Record<string, unknown>;
    expect(view).toMatchObject({ status: TaskStatus.IN_REVIEW, reviewState: 'awaiting_reviews' });
    // A normal task of the same campaign after rita's one review reads the same.
    const peer = db.tasks.find((t) => !t.isGold && t.campaignId === clone.campaignId) as Row;
    await db.service.review(peer.id, { scores }, rita);
    const normal = (await db.service.get(peer.id, rita)) as Record<string, unknown>;
    const strip = (v: Record<string, unknown>) => {
      const { taskReviews, ...rest } = shape(v);
      const reviews = (taskReviews as Array<Record<string, unknown>>).map((r) => {
        const { taskId: _t, ...kept } = shape(r);
        void _t;
        return kept;
      });
      return { ...rest, taskReviews: reviews };
    };
    expect(strip(view)).toEqual(strip(normal));
    expect(ids(await db.service.list(rita))).toEqual(listBefore);
    expect(ids(await db.service.list(rita, undefined, true))).not.toContain(cloneId);
    expect(await db.campaigns.list(rita)).toEqual(countsBefore);
  });

  it('scores the clone review against the gold answer in calibration', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const [cloneId] = fresh(await db.service.list(rita));
    // Every backlog gold is deliberately broken (expected reject); rita accepts it.
    await db.service.review(cloneId, { scores }, rita);
    await db.service.review('n0', { scores }, rita);
    const [row] = (await db.service.calibration()).filter((r) => r.reviewerId === rita.expertId);
    expect(row).toMatchObject({ totalReviews: 2, goldReviews: 1, correct: 0, falseAccepts: 1 });
  });

  it('does not clone the same gold for the same reviewer twice', async () => {
    const db = fakeDb(backlog());
    const [rita] = dueNow(1).map((r) => user(r));
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const queue = ids(await db.service.list(rita, undefined, true));
      const [cloneId] = fresh(queue);
      // Work the queue: the clone if there is one, a regular task otherwise.
      const pick = cloneId ?? queue[0];
      if (!pick) break;
      if (cloneId) {
        const source = db.tasks.find((t) => t.id === cloneId)?.goldSourceId as string;
        expect(seen.has(source)).toBe(false);
        seen.add(source);
      }
      await db.service.review(pick, { scores }, rita);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('gold rate: one review in five, whatever the backlog', () => {
  /** n regular tasks and plenty of gold, with cuid-like ids (hash order is not id order). */
  function large(n: number) {
    const id = (p: string, i: number) =>
      `c${(1_790_000_000_000 + i * 60_000).toString(36)}${i.toString(36).padStart(4, '0')}w9qc${p}${i.toString(36).padStart(7, '0')}`;
    return [
      ...Array.from({ length: n }, (_, i) =>
        task(id('n', i), { gold: false, createdAt: at(i), campaignId: i % 2 ? 'c2' : 'c1' }),
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        task(id('g', i), { gold: true, createdAt: at(n + i), campaignId: i % 2 ? 'c2' : 'c1' }),
      ),
    ];
  }

  for (const n of [20, 1000]) {
    it(`gives a head-first reviewer exactly one gold per block of five (backlog ${n})`, async () => {
      const db = fakeDb(large(n));
      for (const rita of [user('rita'), user('sam')]) {
        const gold: boolean[] = [];
        for (let k = 0; k < 20; k++) {
          const [head] = ids(await db.service.list(rita, undefined, true));
          gold.push((db.tasks.find((t) => t.id === head) as Row).isGold);
          await db.service.review(head, { scores }, rita);
        }
        for (let block = 0; block < 4; block++) {
          expect(gold.slice(block * 5, block * 5 + 5).filter(Boolean)).toHaveLength(1);
        }
      }
    });
  }
});

describe('visibility: a hidden gold id answers like a missing one, on every endpoint', () => {
  async function setup() {
    const db = fakeDb(backlog());
    const [owner] = dueNow(1).map((r) => user(r));
    const [cloneId] = fresh(await db.service.list(owner));
    return { db, owner, cloneId };
  }

  const endpoints = (s: TaskService, id: string, viewer: AuthUser) => [
    () => s.get(id, viewer),
    () => s.verification(id, viewer),
    () => s.review(id, { scores }, viewer),
    () => s.adjudicate(id, { verdict: 'accept', reason: 'x' }, viewer),
  ];

  it('404s a gold source and another reviewer\'s clone for reviewer, adjudicator and author', async () => {
    const { db, cloneId } = await setup();
    const viewers = [
      user('other'),
      user('adj', Role.ADJUDICATOR),
      user('ann', Role.AUTHOR),
      // The gold's own author is an admin; a non-admin author of the same name sees nothing.
      user('admin', Role.AUTHOR),
    ];
    for (const viewer of viewers) {
      for (const id of [...goldIds, cloneId, 'no-such-task']) {
        for (const call of endpoints(db.service, id, viewer)) {
          await expect(call()).rejects.toBeInstanceOf(NotFoundException);
        }
      }
    }
  });

  it('404s another reviewer\'s clone even for an admin, who still sees the gold sources', async () => {
    const { db, cloneId } = await setup();
    const admin = user('boss', Role.ADMIN);
    for (const call of endpoints(db.service, cloneId, admin)) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    const list = ids(await db.service.list(admin));
    expect(list).toEqual(expect.arrayContaining(goldIds));
    expect(list).not.toContain(cloneId);
    // Gold is reviewed only through a clone, never directly.
    await expect(db.service.review('g0', { scores }, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('shows the owner their clone on every endpoint', async () => {
    const { db, owner, cloneId } = await setup();
    await expect(db.service.get(cloneId, owner)).resolves.toMatchObject({ id: cloneId });
    await expect(db.service.verification(cloneId, owner)).resolves.toMatchObject({
      taskId: cloneId,
    });
    // Not split, so not awaiting adjudication: the same answer as for a normal task.
    await expect(
      db.service.adjudicate(cloneId, { verdict: 'accept', reason: 'x' }, owner),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps every campaign filter in agreement with the unfiltered list', async () => {
    const { db, owner, cloneId } = await setup();
    for (const queue of [false, true]) {
      const byCampaign = [
        ...(await db.service.list(owner, 'c1', queue)),
        ...(await db.service.list(owner, 'c2', queue)),
      ];
      expect(fresh(byCampaign)).toEqual([cloneId]);
    }
  });
});

describe('campaign count: what the viewer can see, never the hidden gold', () => {
  it('equals the length of the viewer\'s own list, per campaign', async () => {
    const db = fakeDb(backlog());
    const [owner] = dueNow(1).map((r) => user(r));
    await db.service.list(owner); // writes owner's clone
    const calm = quiet(db);
    const viewers = [
      owner,
      calm,
      user('adj', Role.ADJUDICATOR),
      user('ann', Role.AUTHOR),
      user('boss', Role.ADMIN),
    ];
    for (const viewer of viewers) {
      await db.service.list(viewer); // any clone due to this viewer is written by now
      const counts = await db.campaigns.list(viewer);
      for (const c of counts) {
        const listed = await db.service.list(viewer, c.id);
        expect(c._count.tasks).toBe(listed.length);
      }
    }
    // A reviewer without a clone counts only the normal tasks.
    const [other] = await db.campaigns.list(calm);
    expect(other._count.tasks).toBe(4);
  });
});

describe('task view: review is blind to the author', () => {
  it('hides the author from reviewers and adjudicators, in the list, the queue and a task', async () => {
    const db = fakeDb(backlog());
    for (const viewer of [user(dueNow(1)[0]), user('adj', Role.ADJUDICATOR)]) {
      const views = [
        ...(await db.service.list(viewer)),
        ...(await db.service.list(viewer, undefined, true)),
        await db.service.get('n0', viewer),
      ];
      for (const v of views) {
        expect(v).toMatchObject({ authorId: null, author: null });
      }
    }
  });

  it('shows the author to an admin, and to the author on their own task', async () => {
    const db = fakeDb(backlog());
    expect(await db.service.get('n0', user('boss', Role.ADMIN))).toMatchObject({
      authorId: 'ben',
      author: { id: 'ben', name: 'BEN' },
    });
    expect(await db.service.get('n0', user('ben', Role.AUTHOR))).toMatchObject({
      authorId: 'ben',
    });
  });
});

describe('task view: reviews stay hidden while the second is open', () => {
  it('redacts scores on a task with one review', async () => {
    const db = fakeDb([
      task('n1', {
        gold: false,
        status: TaskStatus.IN_REVIEW,
        reviews: [review('rn', 'n1', 'alice')],
      }),
    ]);
    const v = (await db.service.get('n1', user('bob'))) as { taskReviews: object[] };
    expect(v.taskReviews).toEqual([
      { id: 'rn', taskId: 'n1', reviewerId: 'alice', createdAt: reviewedAt },
    ]);
  });
});
