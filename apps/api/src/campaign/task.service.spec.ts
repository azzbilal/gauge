import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import { AuthUser } from '../auth/auth.decorators';
import { TaskService } from './task.service';

// A gold task must be indistinguishable from a normal task to whoever reads it
// (docs/pipeline.md §3). These tests read tasks through the service with a stub Prisma.

const created = new Date('2026-11-01T10:00:00Z');
const reviewedAt = new Date('2026-11-02T09:30:00Z');

function user(expertId: string, role: Role = Role.REVIEWER): AuthUser {
  return { id: `u-${expertId}`, name: expertId, email: `${expertId}@x`, role, expertId };
}

function review(id: string, taskId: string, expertId: string, accepted = true) {
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
    status: TaskStatus;
    reviews: unknown[];
    createdAt?: Date;
    campaignId?: string;
    authorId?: string;
  },
) {
  const campaignId = opts.campaignId ?? 'c1';
  const authorId = opts.authorId ?? 'author';
  return {
    id,
    campaignId,
    authorId,
    prompt: 'p',
    spec: null,
    reference: null,
    status: opts.status,
    isGold: opts.gold,
    goldExpectedAccept: opts.gold ? false : null,
    createdAt: opts.createdAt ?? created,
    // A normal task's row is written with its first review; a gold row never is.
    updatedAt: opts.gold ? created : new Date(reviewedAt.getTime() + 3),
    campaign: { id: campaignId, name: campaignId.toUpperCase() },
    author: { id: authorId, name: authorId.toUpperCase() },
    taskReviews: opts.reviews,
  };
}

type FindMany = {
  where?: { campaignId?: string };
  orderBy?: { createdAt?: 'asc' | 'desc' };
};

function serviceWith(rows: ReturnType<typeof task>[]) {
  const prisma = {
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      // Honours the filter and order the service asks for, like the database would.
      findMany: async ({ where, orderBy }: FindMany = {}) => {
        const out = rows.filter((r) => !where?.campaignId || r.campaignId === where.campaignId);
        const dir = orderBy?.createdAt === 'desc' ? -1 : orderBy?.createdAt === 'asc' ? 1 : 0;
        return dir === 0
          ? out
          : [...out].sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
      },
    },
    reviewDecision: { findMany: async () => [] },
  };
  return new TaskService(prisma as never, {} as never);
}

// The normal task after alice's first review, and a gold task alice and two others reviewed.
const normal = task('n1', {
  gold: false,
  status: TaskStatus.IN_REVIEW,
  reviews: [review('rn', 'n1', 'alice')],
});
const gold = task('g1', {
  gold: true,
  status: TaskStatus.SUBMITTED,
  reviews: [review('rg-b', 'g1', 'bob'), review('rg', 'g1', 'alice'), review('rg-c', 'g1', 'carol')],
});
const untouchedNormal = task('n2', { gold: false, status: TaskStatus.SUBMITTED, reviews: [] });
const untouchedGold = task('g2', { gold: true, status: TaskStatus.SUBMITTED, reviews: [] });

/** Everything a client can see, with the ids that differ between two tasks removed. */
function shape(view: Record<string, unknown>) {
  const { id: _id, ...rest } = view;
  void _id;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      taskReviews: (rest.taskReviews as Array<Record<string, unknown>>).map(
        ({ id: _r, taskId: _t, ...r }) => {
          void _r;
          void _t;
          return r;
        },
      ),
    }),
  );
}

describe('task view: a gold task looks like a normal one', () => {
  const service = serviceWith([normal, gold, untouchedNormal, untouchedGold]);
  const alice = user('alice');

  it('after the viewer reviewed it, matches a normal task after its first review', async () => {
    const g = (await service.get('g1', alice)) as Record<string, unknown>;
    const n = (await service.get('n1', alice)) as Record<string, unknown>;
    expect(shape(g)).toEqual(shape(n));
    expect(g.status).toBe(TaskStatus.IN_REVIEW);
    expect(g.taskReviews).toEqual([
      { id: 'rg', taskId: 'g1', reviewerId: 'alice', createdAt: reviewedAt },
    ]);
  });

  it('before the viewer reviewed it, matches a normal task nobody has reviewed', async () => {
    const dave = user('dave');
    // dave may read only the gold task due to him now; it is one of g1 and g2.
    const dueId = ids(await service.list(dave)).find((id) => id.startsWith('g'));
    expect(dueId).toBeDefined();
    const g = (await service.get(dueId as string, dave)) as Record<string, unknown>;
    const n = (await service.get('n2', dave)) as Record<string, unknown>;
    expect(shape(g)).toEqual(shape(n));
    // Bob, alice and carol reviewed g1; dave never sees those reviews.
    expect(g.taskReviews).toEqual([]);
  });

  it('never returns the gold marker or answer, in any view', async () => {
    const views = [
      await service.get('g1', alice),
      await service.get('g1', user('admin', Role.ADMIN)),
      ...(await service.list(alice)),
      ...(await service.list(user('erin'), undefined, true)),
    ];
    for (const v of views) {
      expect(v).not.toHaveProperty('isGold');
      expect(v).not.toHaveProperty('goldExpectedAccept');
      // A review writes a normal task's row but never a gold one's.
      expect(v).not.toHaveProperty('updatedAt');
      for (const r of (v as { taskReviews: object[] }).taskReviews) {
        expect(r).not.toHaveProperty('scores');
        expect(r).not.toHaveProperty('accepted');
      }
    }
  });
});

// A backlog in two campaigns: regular tasks, and gold tasks the admin wrote.
const at = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
const backlog = [
  ...Array.from({ length: 8 }, (_, i) =>
    task(`n${i}`, {
      gold: false,
      status: TaskStatus.SUBMITTED,
      reviews: [],
      createdAt: at(i),
      campaignId: i % 2 ? 'c2' : 'c1',
      authorId: i % 3 ? 'ann' : 'ben',
    }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    task(`g${i}`, {
      gold: true,
      status: TaskStatus.SUBMITTED,
      reviews: [],
      createdAt: at(30 + i),
      campaignId: i % 2 ? 'c2' : 'c1',
      authorId: 'admin',
    }),
  ),
];
const goldIds = new Set(backlog.filter((t) => t.isGold).map((t) => t.id));
const ids = (views: unknown[]) => (views as Array<{ id: string }>).map((v) => v.id);
const unreviewedGold = (views: unknown[]) =>
  (views as Array<{ id: string; taskReviews: unknown[] }>)
    .filter((v) => goldIds.has(v.id) && v.taskReviews.length === 0)
    .map((v) => v.id);

describe('task list: the plain list and the queue agree on gold', () => {
  const service = serviceWith(backlog);
  const reviewers = ['rita', 'sam', 'tom', 'uma', 'vic'].map((r) => user(r));

  it('shows a reviewer only the gold their queue serves, never the ones not yet due', async () => {
    for (const r of reviewers) {
      const list = await service.list(r);
      const queue = await service.list(r, undefined, true);
      // Every queue row is in the list, and the list holds no unreviewed gold the queue lacks.
      expect(ids(list)).toEqual(expect.arrayContaining(ids(queue)));
      expect(unreviewedGold(list)).toEqual(unreviewedGold(queue));
      // A fresh reviewer owes one gold review in this block: exactly one is shown.
      expect(unreviewedGold(list)).toHaveLength(1);
    }
  });

  it('picks the same gold whatever campaign the list is filtered to', async () => {
    for (const r of reviewers) {
      const due = unreviewedGold(await service.list(r));
      for (const queue of [false, true]) {
        const byCampaign = [
          ...(await service.list(r, 'c1', queue)),
          ...(await service.list(r, 'c2', queue)),
        ];
        expect(unreviewedGold(byCampaign)).toEqual(due);
      }
    }
  });

  it('shows no unreviewed gold once the block has had its gold', async () => {
    // rita has reviewed one gold task: her first block of five owes no more.
    const rows = backlog.map((t) =>
      t.id === 'g0' ? { ...t, taskReviews: [review('rg0', 'g0', 'rita')] } : t,
    );
    const s = serviceWith(rows);
    const rita = user('rita');
    const list = await s.list(rita);
    expect(unreviewedGold(list)).toEqual([]);
    expect(unreviewedGold(await s.list(rita, undefined, true))).toEqual([]);
    // The gold she reviewed stays visible, like any task she reviewed.
    expect(ids(list)).toContain('g0');
  });

  it('answers 404 for a gold task that is not due, as for one that does not exist', async () => {
    const rita = user('rita');
    const [due] = unreviewedGold(await service.list(rita));
    for (const id of goldIds) {
      if (id === due) await expect(service.get(id, rita)).resolves.toMatchObject({ id });
      else await expect(service.get(id, rita)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('shows gold to no one who cannot review it', async () => {
    for (const viewer of [user('ann', Role.AUTHOR), user('adj', Role.ADJUDICATOR)]) {
      expect(ids(await service.list(viewer)).filter((id) => goldIds.has(id))).toEqual([]);
    }
    expect(ids(await service.list(user('admin2', Role.ADMIN)))).toEqual(
      expect.arrayContaining([...goldIds]),
    );
  });
});

describe('task view: review is blind to the author', () => {
  const service = serviceWith(backlog);

  it('hides the author from reviewers and adjudicators, in the list, the queue and a task', async () => {
    for (const viewer of [user('rita'), user('adj', Role.ADJUDICATOR)]) {
      const views = [
        ...(await service.list(viewer)),
        ...(await service.list(viewer, undefined, true)),
        await service.get('n0', viewer),
      ];
      for (const v of views) {
        expect(v).toMatchObject({ authorId: null, author: null });
      }
    }
  });

  it('shows the author to an admin, and to the author on their own task', async () => {
    expect(await service.get('n0', user('admin2', Role.ADMIN))).toMatchObject({
      authorId: 'ben',
      author: { id: 'ben', name: 'BEN' },
    });
    expect(await service.get('n0', user('ben', Role.AUTHOR))).toMatchObject({ authorId: 'ben' });
  });
});
