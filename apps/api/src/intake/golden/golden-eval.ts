import { IntakeAssessment, LlmScoringProvider, RubricCriterion } from '../llm/types';
import { needsHumanReview, LOW_CONFIDENCE_THRESHOLD } from '../routing';

/**
 * Gate 1: the intake agent's agreement with a hand-labelled golden set.
 *
 * Each golden pair is a CV, the posting it was scored against, and the score a senior
 * reviewer gave on every rubric criterion. The harness scores each CV with the configured
 * intake provider (the same one POST /intake/runs uses) and compares.
 *
 *   criterion agrees  |agent - gold| <= tolerance (default 1 point on the 0-5 scale)
 *   pair passes       every criterion agrees
 *   pair errors       the provider failed to score it; an error is never a pass
 *   agreement rate    passed / all pairs, so an error counts against the rate
 *
 * Also reported, not part of pass/fail: exact and within-tolerance rates and mean absolute
 * error per criterion, and routing agreement (does the agent send the CV to a human
 * exactly when the gold confidence is below the same threshold?).
 *
 * Leak check: the local model is prompted with worked examples (intake/llm/examples.json).
 * A golden CV that mostly repeats one of those CVs measures recall, not judgment, so each
 * pair carries its overlap with the closest example and is flagged at LEAK_THRESHOLD; the
 * summary repeats the agreement rate without flagged pairs.
 *
 * No database and no HTTP: pure functions plus runGolden(), which takes the provider.
 */

export const DEFAULT_TOLERANCE = 1;
/** Share of a golden CV's content words found in one few-shot example CV. */
export const LEAK_THRESHOLD = 0.5;

export interface GoldenPair {
  id: string;
  cv: string;
  postingTitle: string;
  goldScores: Record<string, number>;
  goldOverallConfidence: number;
}

export class GoldenSetError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a parsed golden-set file against the rubric. Strict: one bad pair rejects the
 * file, because a pair dropped silently would inflate the agreement rate.
 */
export function parseGoldenSet(raw: unknown, criteria: RubricCriterion[], postingTitle: string): GoldenPair[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GoldenSetError('golden set must be a non-empty JSON array');
  }
  const ids = new Set<string>();
  const criterionIds = criteria.map((c) => c.id).sort();
  return raw.map((p, i) => {
    const at = `pair ${i}`;
    if (!isObject(p)) throw new GoldenSetError(`${at}: not an object`);
    const { id, cv, postingTitle: title, goldScores, goldOverallConfidence } = p;
    if (typeof id !== 'string' || !id.trim()) throw new GoldenSetError(`${at}: missing id`);
    if (ids.has(id)) throw new GoldenSetError(`${id}: duplicate id`);
    ids.add(id);
    if (typeof cv !== 'string' || !cv.trim()) throw new GoldenSetError(`${id}: missing cv`);
    if (title !== postingTitle) {
      throw new GoldenSetError(`${id}: postingTitle ${JSON.stringify(title)} is not the posting scored against (${JSON.stringify(postingTitle)})`);
    }
    if (!isObject(goldScores)) throw new GoldenSetError(`${id}: goldScores must be an object`);
    const keys = Object.keys(goldScores).sort();
    if (keys.join(',') !== criterionIds.join(',')) {
      throw new GoldenSetError(`${id}: goldScores has [${keys.join(', ')}], rubric has [${criterionIds.join(', ')}]`);
    }
    for (const k of keys) {
      const s = goldScores[k];
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > 5) {
        throw new GoldenSetError(`${id}: goldScores.${k} must be a whole number from 0 to 5`);
      }
    }
    if (typeof goldOverallConfidence !== 'number' || goldOverallConfidence < 0 || goldOverallConfidence > 1) {
      throw new GoldenSetError(`${id}: goldOverallConfidence must be a number from 0 to 1`);
    }
    return { id, cv, postingTitle: title, goldScores: goldScores as Record<string, number>, goldOverallConfidence };
  });
}

// ------------------------------------------------------------------------- leak check

const STOPWORDS = new Set(
  'the and for with from that this are was has have into not but its his her their our you your who all any one per uses used'.split(' '),
);

function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9&+#.-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/** The closest few-shot example to a CV: the share of the CV's content words it contains. */
export function exampleOverlap(cv: string, examples: { id: string; cv: string }[]): { overlap: number; exampleId: string | null } {
  const mine = contentWords(cv);
  let best = { overlap: 0, exampleId: null as string | null };
  if (mine.size === 0) return best;
  for (const ex of examples) {
    const theirs = contentWords(ex.cv);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const overlap = shared / mine.size;
    if (overlap > best.overlap) best = { overlap, exampleId: ex.id };
  }
  return best;
}

// ------------------------------------------------------------------------- comparison

export interface CriterionComparison {
  criterionId: string;
  gold: number;
  agent: number | null;
  diff: number | null;
  agrees: boolean;
}

export interface PairResult {
  id: string;
  status: 'pass' | 'fail' | 'error';
  criteria: CriterionComparison[];
  goldNeedsReview: boolean;
  agentNeedsReview: boolean | null;
  agentConfidence: number | null;
  overlap: number;
  overlapExampleId: string | null;
  leak: boolean;
  latencyMs: number;
  error?: string;
}

/** Compare one assessment with its golden pair. A criterion the agent did not score disagrees. */
export function comparePair(
  pair: GoldenPair,
  assessment: Pick<IntakeAssessment, 'scores' | 'overallConfidence'>,
  tolerance = DEFAULT_TOLERANCE,
): Pick<PairResult, 'status' | 'criteria' | 'agentNeedsReview' | 'agentConfidence'> {
  const criteria = Object.keys(pair.goldScores)
    .sort()
    .map((criterionId): CriterionComparison => {
      const gold = pair.goldScores[criterionId];
      const scored = assessment.scores.find((s) => s.criterionId === criterionId);
      if (!scored) return { criterionId, gold, agent: null, diff: null, agrees: false };
      const diff = scored.score - gold;
      return { criterionId, gold, agent: scored.score, diff, agrees: Math.abs(diff) <= tolerance };
    });
  return {
    status: criteria.every((c) => c.agrees) ? 'pass' : 'fail',
    criteria,
    agentNeedsReview: needsHumanReview(assessment),
    agentConfidence: assessment.overallConfidence,
  };
}

export const goldNeedsReview = (pair: GoldenPair) => pair.goldOverallConfidence < LOW_CONFIDENCE_THRESHOLD;

// ------------------------------------------------------------------------- summary

export interface CriterionSummary {
  criterionId: string;
  judged: number;
  exactRate: number | null;
  withinToleranceRate: number | null;
  meanAbsError: number | null;
  /** Mean signed difference (agent - gold): positive means the agent scores high. */
  bias: number | null;
}

export interface GoldenSummary {
  tolerance: number;
  pairs: number;
  judged: number;
  passed: number;
  failed: number;
  errors: number;
  /** passed / pairs; an error counts as a failure. */
  agreementRate: number;
  /** The same over pairs not flagged as leaked from the few-shot examples. */
  clean: { pairs: number; passed: number; agreementRate: number | null; excluded: string[] };
  routingAgreement: number | null;
  perCriterion: CriterionSummary[];
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

export function summarise(results: PairResult[], tolerance = DEFAULT_TOLERANCE): GoldenSummary {
  const judged = results.filter((r) => r.status !== 'error');
  const passed = results.filter((r) => r.status === 'pass').length;
  const clean = results.filter((r) => !r.leak);
  const cleanPassed = clean.filter((r) => r.status === 'pass').length;
  const ids = [...new Set(results.flatMap((r) => r.criteria.map((c) => c.criterionId)))].sort();
  const perCriterion = ids.map((criterionId): CriterionSummary => {
    const rows = judged
      .map((r) => r.criteria.find((c) => c.criterionId === criterionId))
      .filter((c): c is CriterionComparison => !!c && c.diff !== null);
    const diffs = rows.map((c) => c.diff as number);
    return {
      criterionId,
      judged: rows.length,
      exactRate: ratio(diffs.filter((d) => d === 0).length, rows.length),
      withinToleranceRate: ratio(rows.filter((c) => c.agrees).length, rows.length),
      meanAbsError: ratio(diffs.reduce((a, d) => a + Math.abs(d), 0), rows.length),
      bias: ratio(diffs.reduce((a, d) => a + d, 0), rows.length),
    };
  });
  return {
    tolerance,
    pairs: results.length,
    judged: judged.length,
    passed,
    failed: judged.length - passed,
    errors: results.length - judged.length,
    agreementRate: results.length === 0 ? 0 : passed / results.length,
    clean: {
      pairs: clean.length,
      passed: cleanPassed,
      agreementRate: ratio(cleanPassed, clean.length),
      excluded: results.filter((r) => r.leak).map((r) => r.id),
    },
    routingAgreement: ratio(judged.filter((r) => r.agentNeedsReview === r.goldNeedsReview).length, judged.length),
    perCriterion,
  };
}

// ------------------------------------------------------------------------- run

export interface RunOptions {
  criteria: RubricCriterion[];
  postingText: string;
  examples: { id: string; cv: string }[];
  tolerance?: number;
  /** Called after each pair, for progress output. */
  onResult?: (result: PairResult, index: number, total: number) => void;
}

/** Score every pair, one after another (a local model serves one request at a time). */
export async function runGolden(pairs: GoldenPair[], provider: LlmScoringProvider, opts: RunOptions): Promise<PairResult[]> {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const results: PairResult[] = [];
  for (const [i, pair] of pairs.entries()) {
    const { overlap, exampleId } = exampleOverlap(pair.cv, opts.examples);
    const base = {
      id: pair.id,
      goldNeedsReview: goldNeedsReview(pair),
      overlap,
      overlapExampleId: exampleId,
      leak: overlap >= LEAK_THRESHOLD,
    };
    const started = Date.now();
    let result: PairResult;
    try {
      const assessment = await provider.scoreCv(pair.cv, opts.postingText, opts.criteria);
      result = { ...base, ...comparePair(pair, assessment, tolerance), latencyMs: Date.now() - started };
    } catch (err) {
      result = {
        ...base,
        status: 'error',
        criteria: Object.keys(pair.goldScores)
          .sort()
          .map((criterionId) => ({ criterionId, gold: pair.goldScores[criterionId], agent: null, diff: null, agrees: false })),
        agentNeedsReview: null,
        agentConfidence: null,
        latencyMs: Date.now() - started,
        error: (err as Error)?.message ?? String(err),
      };
    }
    results.push(result);
    opts.onResult?.(result, i, pairs.length);
  }
  return results;
}
