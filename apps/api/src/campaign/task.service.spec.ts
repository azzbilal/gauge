import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
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

function task(id: string, opts: { gold: boolean; status: TaskStatus; reviews: unknown[] }) {
  return {
    id,
    campaignId: 'c1',
    authorId: 'author',
    prompt: 'p',
    spec: null,
    reference: null,
    status: opts.status,
    isGold: opts.gold,
    goldExpectedAccept: opts.gold ? false : null,
    createdAt: created,
    // A normal task's row is written with its first review; a gold row never is.
    updatedAt: opts.gold ? created : new Date(reviewedAt.getTime() + 3),
    campaign: { id: 'c1', name: 'C' },
    author: { id: 'author', name: 'A' },
    taskReviews: opts.reviews,
  };
}

function serviceWith(rows: ReturnType<typeof task>[]) {
  const prisma = {
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      findMany: async () => rows,
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
    const g = (await service.get('g2', dave)) as Record<string, unknown>;
    const n = (await service.get('n2', dave)) as Record<string, unknown>;
    expect(shape(g)).toEqual(shape(n));
    // Bob, alice and carol reviewed g1; dave sees none of those reviews.
    expect(((await service.get('g1', dave)) as Record<string, unknown>).taskReviews).toEqual([]);
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
