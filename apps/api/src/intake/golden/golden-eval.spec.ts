import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { IntakeAssessment, LlmScoringProvider } from '../llm/types';
import { CAD_TASK_AUTHOR_CRITERIA as CRITERIA, CAD_TASK_AUTHOR_POSTING as POSTING } from '../posting';
import {
  GoldenPair,
  GoldenSetError,
  LEAK_THRESHOLD,
  comparePair,
  exampleOverlap,
  parseGoldenSet,
  runGolden,
  summarise,
} from './golden-eval';

const pair = (id: string, scores: Record<string, number>, conf = 0.8): GoldenPair => ({
  id,
  cv: `CV of ${id}: fluent in CadQuery`,
  postingTitle: POSTING.title,
  goldScores: scores,
  goldOverallConfidence: conf,
});

const assessment = (scores: Record<string, number>, conf = 0.8): IntakeAssessment => ({
  scores: Object.entries(scores).map(([criterionId, score]) => ({
    criterionId,
    label: criterionId,
    score,
    evidence: 'x',
    confidence: conf,
  })),
  overallConfidence: conf,
  usage: { inputTokens: 0, outputTokens: 0 },
  model: 'stub',
  costUsd: 0,
});

/** A provider that answers from a table keyed by CV, and throws for CVs it does not know. */
function stubProvider(answers: Record<string, IntakeAssessment>): LlmScoringProvider {
  return {
    name: 'stub',
    promptVersion: 'stub-v1',
    scoreCv: async (cv) => {
      const a = answers[cv];
      if (!a) throw new Error('model unavailable');
      return a;
    },
  };
}

const opts = { criteria: CRITERIA, postingText: POSTING.title, examples: [] };

describe('parseGoldenSet', () => {
  it('accepts the committed 20-pair golden set', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../../../prisma/golden-set.json'), 'utf8'));
    const pairs = parseGoldenSet(raw, CRITERIA, POSTING.title);
    expect(pairs).toHaveLength(20);
  });

  it.each([
    ['not an array', {}, /non-empty JSON array/],
    ['empty', [], /non-empty JSON array/],
    ['a missing criterion', [{ ...pair('a', { cad: 1, geo: 1, code: 1 }) }], /goldScores has/],
    ['a fractional score', [pair('a', { cad: 1.5, geo: 1, code: 1, comm: 1 })], /whole number/],
    ['a score above 5', [pair('a', { cad: 6, geo: 1, code: 1, comm: 1 })], /whole number/],
    ['another posting', [{ ...pair('a', { cad: 1, geo: 1, code: 1, comm: 1 }), postingTitle: 'Other' }], /postingTitle/],
    ['a duplicate id', [pair('a', { cad: 1, geo: 1, code: 1, comm: 1 }), pair('a', { cad: 1, geo: 1, code: 1, comm: 1 })], /duplicate/],
    ['a confidence above 1', [pair('a', { cad: 1, geo: 1, code: 1, comm: 1 }, 1.5)], /goldOverallConfidence/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseGoldenSet(raw, CRITERIA, POSTING.title)).toThrow(GoldenSetError);
    expect(() => parseGoldenSet(raw, CRITERIA, POSTING.title)).toThrow(message);
  });
});

describe('comparePair', () => {
  const gold = pair('p', { cad: 5, geo: 4, code: 1, comm: 3 });

  it('passes when every criterion is within one point', () => {
    const r = comparePair(gold, assessment({ cad: 4, geo: 5, code: 1, comm: 2 }));
    expect(r.status).toBe('pass');
    expect(r.criteria.map((c) => c.diff)).toEqual([-1, 0, -1, 1]); // cad code comm geo, sorted
  });

  it('fails when any criterion is two points off', () => {
    const r = comparePair(gold, assessment({ cad: 5, geo: 4, code: 3, comm: 3 }));
    expect(r.status).toBe('fail');
    expect(r.criteria.find((c) => c.criterionId === 'code')).toMatchObject({ agent: 3, diff: 2, agrees: false });
  });

  it('fails on a criterion the agent did not score', () => {
    const r = comparePair(gold, assessment({ cad: 5, geo: 4, code: 1 }));
    expect(r.status).toBe('fail');
    expect(r.criteria.find((c) => c.criterionId === 'comm')).toMatchObject({ agent: null, agrees: false });
  });

  it('with tolerance 0 needs exact scores', () => {
    expect(comparePair(gold, assessment({ cad: 4, geo: 4, code: 1, comm: 3 }), 0).status).toBe('fail');
    expect(comparePair(gold, assessment({ cad: 5, geo: 4, code: 1, comm: 3 }), 0).status).toBe('pass');
  });

  it('routes to a human on low confidence, as IntakeService does', () => {
    expect(comparePair(gold, assessment({ cad: 5, geo: 4, code: 1, comm: 3 }, 0.6)).agentNeedsReview).toBe(true);
    expect(comparePair(gold, assessment({ cad: 5, geo: 4, code: 1, comm: 3 }, 0.9)).agentNeedsReview).toBe(false);
  });
});

describe('exampleOverlap', () => {
  it('flags a CV that repeats a few-shot example and not an unrelated one', () => {
    const examples = [{ id: 'maria', cv: 'Built an internal CadQuery library of 40+ parametric components driven from a YAML spec, used by 12 engineers.' }];
    const copied = exampleOverlap('Built a CadQuery library driven from YAML, used by 12 engineers.', examples);
    const other = exampleOverlap('Marketing coordinator running HubSpot campaigns.', examples);
    expect(copied.overlap).toBeGreaterThanOrEqual(LEAK_THRESHOLD);
    expect(copied.exampleId).toBe('maria');
    expect(other.overlap).toBe(0);
  });
});

describe('runGolden + summarise', () => {
  it('counts a provider failure as an error, never a pass, and against the rate', async () => {
    const a = pair('a', { cad: 5, geo: 4, code: 1, comm: 3 });
    const b = pair('b', { cad: 0, geo: 0, code: 5, comm: 4 }, 0.5);
    const c = pair('c', { cad: 2, geo: 2, code: 2, comm: 2 });
    const provider = stubProvider({
      [a.cv]: assessment({ cad: 5, geo: 4, code: 2, comm: 3 }, 0.9), // pass
      [b.cv]: assessment({ cad: 3, geo: 0, code: 5, comm: 4 }, 0.5), // fail on cad
      // c: provider throws
    });
    const results = await runGolden([a, b, c], provider, opts);
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'error']);
    expect(results[2].error).toBe('model unavailable');

    const s = summarise(results);
    expect(s).toMatchObject({ pairs: 3, judged: 2, passed: 1, failed: 1, errors: 1 });
    expect(s.agreementRate).toBeCloseTo(1 / 3);
    // Both scored pairs route the same way as gold: a auto/auto, b human/human.
    expect(s.routingAgreement).toBe(1);
    const cad = s.perCriterion.find((x) => x.criterionId === 'cad')!;
    expect(cad).toMatchObject({ judged: 2, exactRate: 0.5, withinToleranceRate: 0.5, meanAbsError: 1.5, bias: 1.5 });
  });

  it('reports the rate without leaked pairs separately', async () => {
    const a = pair('a', { cad: 5, geo: 5, code: 5, comm: 5 });
    const b = pair('b', { cad: 1, geo: 1, code: 1, comm: 1 });
    b.cv = 'Marketing coordinator running HubSpot campaigns.';
    const provider = stubProvider({
      [a.cv]: assessment({ cad: 5, geo: 5, code: 5, comm: 5 }),
      [b.cv]: assessment({ cad: 4, geo: 4, code: 4, comm: 4 }),
    });
    const results = await runGolden([a, b], provider, { ...opts, examples: [{ id: 'ex', cv: a.cv }] });
    expect(results.map((r) => r.leak)).toEqual([true, false]);
    const s = summarise(results);
    expect(s.agreementRate).toBe(0.5);
    expect(s.clean).toEqual({ pairs: 1, passed: 0, agreementRate: 0, excluded: ['a'] });
  });
});
