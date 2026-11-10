import { readFileSync } from 'fs';
import { join } from 'path';
import { CriterionScore, RawScores, RubricCriterion } from './types';

export const SCORE_MIN = 0;
export const SCORE_MAX = 5;

export const BASE_SYSTEM_PROMPT =
  'You score a candidate CV against a job posting using a fixed rubric. ' +
  'For each criterion return an integer score from 0 to 5, a direct evidence quote from the CV ' +
  '(or "no evidence" if absent), and a confidence from 0 to 1. Be strict and honest; never invent evidence.';

/** Extra guidance for the local model, which learns the calibration from the worked examples. */
export const FEWSHOT_SYSTEM_PROMPT =
  BASE_SYSTEM_PROMPT +
  '\n\nYou will first see worked examples scored by a senior reviewer. Match their calibration:' +
  '\n- Reason criterion by criterion in "reasoning" BEFORE giving scores.' +
  '\n- Score only what the CV explicitly states; general seniority or hobbies are not evidence.' +
  '\n- Score the depth the CV demonstrates, not the tools it names. Using a tool is not mastery of it.' +
  '\n- Use the whole scale. Anchors, consistent with the examples:' +
  '\n  5 = several years of professional work that matches the criterion exactly, with specific and demanding evidence' +
  ' (e.g. building a reusable parametric CadQuery library used by a team; GD&T plus tolerance stack-ups on every assembly).' +
  '\n  4 = strong professional evidence that misses one aspect the posting cares about (e.g. years of GUI CAD but no parametric or code-first work).' +
  '\n  3 = real but limited: narrow, basic, or hobby-scale (e.g. "basic GD&T"; OpenSCAD hobby models; a few small scripts).' +
  '\n  2 = some relevant exposure that is shallow or indirect.' +
  '\n  1 = only an adjacent, transferable skill (e.g. general Python with no CAD use).' +
  '\n  0 = no evidence, with evidence "no evidence".' +
  '\n- Scripts that only automate file handling (export, renaming) show little ability to express geometry in code.' +
  '\n- "evidence" must be ONE contiguous quote copied verbatim from the CV being scored (no "...", no joined fragments), never from the examples.' +
  '\n- Lower confidence when the CV is thin or the evidence is indirect.' +
  '\n- Return exactly one score per rubric criterion, using the criterion ids given.';

export function buildUserPrompt(posting: string, criteria: RubricCriterion[], cv: string): string {
  return [`Posting:\n${posting}`, `Rubric criteria:\n${JSON.stringify(criteria)}`, `CV:\n${cv}`].join('\n\n');
}

/** JSON schema for the structured response. `reasoning` comes first so the model thinks before it scores. */
export function scoresJsonSchema(criteria: RubricCriterion[], withReasoning: boolean) {
  const properties: Record<string, unknown> = {};
  if (withReasoning) properties.reasoning = { type: 'string' };
  properties.scores = {
    type: 'array',
    minItems: criteria.length,
    maxItems: criteria.length,
    items: {
      type: 'object',
      properties: {
        criterionId: { type: 'string', enum: criteria.map((c) => c.id) },
        score: { type: 'integer', minimum: SCORE_MIN, maximum: SCORE_MAX },
        evidence: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['criterionId', 'score', 'evidence', 'confidence'],
    },
  };
  properties.overallConfidence = { type: 'number', minimum: 0, maximum: 1 };
  return {
    type: 'object',
    properties,
    required: [...(withReasoning ? ['reasoning'] : []), 'scores', 'overallConfidence'],
  };
}

// ---------------------------------------------------------------------------
// Few-shot examples (Claude-authored reference scorings)
// ---------------------------------------------------------------------------

export interface FewShotExample {
  id: string;
  cv: string;
  posting: string;
  reasoning: string;
  output: Omit<RawScores, 'reasoning'>;
}

let cachedExamples: FewShotExample[] | null = null;

/** Loads examples.json (copied to dist as a Nest asset). Override with INTAKE_EXAMPLES_PATH. */
export function loadFewShotExamples(): FewShotExample[] {
  if (cachedExamples) return cachedExamples;
  const path = process.env.INTAKE_EXAMPLES_PATH || join(__dirname, 'examples.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FewShotExample[];
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array`);
  cachedExamples = parsed;
  return parsed;
}

/** Only examples scored on exactly this rubric are useful demonstrations. */
export function examplesForRubric(examples: FewShotExample[], criteria: RubricCriterion[]): FewShotExample[] {
  const want = [...criteria.map((c) => c.id)].sort().join(',');
  return examples.filter(
    (ex) => [...ex.output.scores.map((s) => s.criterionId)].sort().join(',') === want,
  );
}

/** Renders the examples as prior user/assistant turns, in the same format as the live request. */
export function fewShotMessages(
  examples: FewShotExample[],
  criteria: RubricCriterion[],
): { role: 'user' | 'assistant'; content: string }[] {
  return examples.flatMap((ex) => [
    { role: 'user' as const, content: buildUserPrompt(ex.posting, criteria, ex.cv) },
    {
      role: 'assistant' as const,
      content: JSON.stringify({ reasoning: ex.reasoning, ...ex.output }),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Validation / normalisation shared by all providers
// ---------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Checks the model returned exactly one score per criterion and coerces
 * numbers into range. Throws on structurally invalid output.
 */
export function normaliseScores(
  raw: RawScores,
  criteria: RubricCriterion[],
): { scores: CriterionScore[]; overallConfidence: number } {
  if (!raw || !Array.isArray(raw.scores)) throw new Error('Model output is missing a "scores" array');

  const byId = new Map(raw.scores.map((s) => [s.criterionId, s]));
  const unknown = raw.scores.map((s) => s.criterionId).filter((id) => !criteria.some((c) => c.id === id));
  const missing = criteria.filter((c) => !byId.has(c.id)).map((c) => c.id);
  if (missing.length || unknown.length || raw.scores.length !== criteria.length) {
    throw new Error(
      `Model scores do not match the rubric (missing: [${missing}], unknown: [${unknown}], got ${raw.scores.length}/${criteria.length})`,
    );
  }

  const scores = criteria.map((c) => {
    const s = byId.get(c.id)!;
    return {
      criterionId: c.id,
      label: c.label,
      score: Math.round(clamp(Number(s.score) || 0, SCORE_MIN, SCORE_MAX)),
      evidence: String(s.evidence ?? '').trim() || 'no evidence',
      confidence: clamp(Number(s.confidence) || 0, 0, 1),
    };
  });

  return { scores, overallConfidence: clamp(Number(raw.overallConfidence) || 0, 0, 1) };
}
