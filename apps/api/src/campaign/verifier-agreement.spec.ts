import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { TaskStatus, Verdict, VerifySubjectType } from '@prisma/client';
import { TaskService } from './task.service';
import {
  VerifierAgreementInput,
  disagreementOf,
  verifierAgreementStats,
} from './verifier-agreement';

const row = (
  taskId: string,
  humanAccepted: boolean,
  verifierPassed: boolean | null,
): VerifierAgreementInput => ({ taskId, humanAccepted, verifierPassed });

describe('verifierAgreementStats', () => {
  it('fills the confusion matrix with human rows and verifier columns', () => {
    const stats = verifierAgreementStats([
      row('a', true, true),
      row('b', true, true),
      row('c', true, false),
      row('d', false, true),
      row('e', false, false),
      row('f', false, false),
    ]);
    expect(stats.confusion).toEqual({
      acceptedPassed: 2,
      acceptedFailed: 1,
      rejectedPassed: 1,
      rejectedFailed: 2,
    });
    expect(stats.compared).toBe(6);
    expect(stats.agreed).toBe(4);
    expect(stats.agreementRate).toBeCloseTo(4 / 6);
    expect(stats.falsePassRate).toBeCloseTo(1 / 3);
    expect(stats.falseFailRate).toBeCloseTo(1 / 3);
    // p_o = 4/6, p_e = 0.5*0.5 + 0.5*0.5 = 0.5 -> kappa = (2/3 - 1/2) / (1/2) = 1/3
    expect(stats.cohenKappa).toBeCloseTo(1 / 3);
  });

  it('keeps tasks without a verifier run out of the rate instead of counting them as fails', () => {
    const stats = verifierAgreementStats([row('a', true, true), row('b', true, null), row('c', false, null)]);
    expect(stats.decidedTasks).toBe(3);
    expect(stats.unverified).toBe(2);
    expect(stats.compared).toBe(1);
    expect(stats.agreementRate).toBe(1);
    expect(stats.confusion.acceptedFailed).toBe(0);
  });

  it('reports null rates when there is nothing to compare', () => {
    const stats = verifierAgreementStats([row('a', true, null)]);
    expect(stats.agreementRate).toBeNull();
    expect(stats.cohenKappa).toBeNull();
    expect(stats.falsePassRate).toBeNull();
    expect(stats.falseFailRate).toBeNull();
    expect(verifierAgreementStats([]).agreementRate).toBeNull();
  });

  it('leaves kappa undefined when both sides gave one answer throughout', () => {
    const stats = verifierAgreementStats([row('a', true, true), row('b', true, true)]);
    expect(stats.agreementRate).toBe(1);
    expect(stats.cohenKappa).toBeNull();
    expect(stats.falsePassRate).toBeNull();
  });

  it('names the kind of each disagreement', () => {
    expect(disagreementOf(row('a', false, true))).toBe('false_pass');
    expect(disagreementOf(row('a', true, false))).toBe('false_fail');
    expect(disagreementOf(row('a', true, true))).toBeNull();
    expect(disagreementOf(row('a', true, null))).toBeNull();
  });
});

describe('TaskService.verifierAgreement', () => {
  const run = (id: string, passed: boolean, results: unknown[] = []) => ({
    id,
    verifierVersion: 'm8-static-cad',
    passed,
    results,
    createdAt: new Date('2026-11-13T10:00:00Z'),
  });

  function serviceWith(tasks: unknown[], decisions: unknown[] = []) {
    const calls: Record<string, unknown> = {};
    const prisma = {
      task: {
        findMany: async (args: unknown) => {
          calls.task = args;
          return tasks;
        },
      },
      reviewDecision: { findMany: async () => decisions },
    };
    return { service: new TaskService(prisma as never, {} as never), calls };
  }

  it('compares decided normal tasks and explains each disagreement', async () => {
    const { service, calls } = serviceWith(
      [
        {
          id: 't1',
          campaignId: 'c1',
          prompt: 'plate',
          status: TaskStatus.ACCEPTED,
          taskReviews: [
            { reviewerExpertId: 'r1', accepted: true },
            { reviewerExpertId: 'r2', accepted: true },
          ],
          verifierRuns: [run('v1', true)],
          requirements: [],
        },
        {
          id: 't2',
          campaignId: 'c1',
          prompt: 'plate with holes',
          status: TaskStatus.REJECTED,
          taskReviews: [
            { reviewerExpertId: 'r1', accepted: true },
            { reviewerExpertId: 'r2', accepted: false },
          ],
          verifierRuns: [
            run('v2', true, [
              { rubric_item_id: 'ri', requirement_id: 'req-1', check: 'static_cad', status: 'pass', pass: true, detail: 'hole count 4 matches spec' },
            ]),
          ],
          requirements: [{ id: 'req-1', text: '4 holes' }],
        },
        {
          id: 't3',
          campaignId: 'c1',
          prompt: 'block',
          status: TaskStatus.ACCEPTED,
          taskReviews: [],
          verifierRuns: [],
          requirements: [],
        },
      ],
      [
        {
          id: 'd1',
          subjectType: 'task',
          subjectId: 't2',
          reviewerId: 'adj',
          verdict: Verdict.REJECT,
          reason: 'holes are never drilled',
          createdAt: new Date(),
        },
      ],
    );

    const report = await service.verifierAgreement('c1');

    // Only decided, non-gold tasks of the campaign; the latest reference run.
    const where = (calls.task as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      isGold: false,
      campaignId: 'c1',
      status: { in: [TaskStatus.ACCEPTED, TaskStatus.REJECTED] },
    });
    const select = (calls.task as { select: { verifierRuns: Record<string, unknown> } }).select;
    expect(select.verifierRuns).toMatchObject({
      where: { subjectType: VerifySubjectType.REFERENCE_SOLUTION },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    expect(report.decidedTasks).toBe(3);
    expect(report.compared).toBe(2);
    expect(report.agreed).toBe(1);
    expect(report.agreementRate).toBe(0.5);
    expect(report.confusion.rejectedPassed).toBe(1);
    expect(report.unverifiedTaskIds).toEqual(['t3']);
    expect(report.disagreements).toEqual([
      expect.objectContaining({
        taskId: 't2',
        kind: 'false_pass',
        humanDecision: 'rejected',
        decidedBy: 'adjudication',
        adjudication: { verdict: Verdict.REJECT, reason: 'holes are never drilled' },
        verifierPassed: true,
        verifierRunId: 'v2',
        verdicts: [
          { requirement: '4 holes', check: 'static_cad', status: 'pass', detail: 'hole count 4 matches spec' },
        ],
      }),
    ]);
  });
});
