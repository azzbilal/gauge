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
  '\n- Reason criterion by criterion in "reasoning" BEFORE giving scores: two or three sentences per criterion,' +
  ' then commit to one score. Do not deliberate between anchors at length.' +
  '\n- Short CVs are normal. A one-line CV is scored on what its role and stated work imply, not marked down for being short.' +
  '\n- Score what the CV states and what its stated work clearly requires: a professional role is evidence of the skills that role uses every day.' +
  ' Do not credit hobbies listed only under interests, and never invent tools or achievements.' +
  '\n- Score each criterion on its own scale below; a weak fit for the posting on one criterion does not lower the others.' +
  '\n- cad (CAD domain depth):' +
  '\n  5 = years of professional parametric CAD with demanding evidence (configurable families, design tables, a code-CAD library).' +
  '\n  4 = professional engineering work that routinely builds or edits CAD models, even if GUI-only, for tooling or CAM, surface-based, or not naming the tool.' +
  '\n  3 = real but narrow CAD: long-term 2D drafting, small-shop part modeling, or a hobby library of parametric models.' +
  '\n  2 = light CAD: hobby or student GUI modeling, building-information modeling, or CAD used only to view or import models into other software.' +
  '\n  1 = no CAD, but adjacent 3D or physical making (renders, hand building).' +
  '\n  0 = nothing related.' +
  '\n- geo (Geometric reasoning), inside or outside CAD:' +
  '\n  5 = demanding geometric or dimensional work as the core of the job (tolerance analysis and stack-ups, complex surfaces).' +
  '\n  4 = professional work that requires reasoning about geometry, constraints or dimensions: machined or sheet-metal parts,' +
  ' motion and kinematics, structural or load analysis, teaching dimensioning.' +
  '\n  3 = practical geometry of limited scope: simple parts and enclosures, machining and toolpaths, rebuilding measured parts, parametric hobby models.' +
  '\n  2 = basic geometry: simple hobby prints, coursework, drawing up plans someone else designed, building by hand from sketches.' +
  '\n  1 = visual or aesthetic 3D only.' +
  '\n  0 = nothing related.' +
  '\n- code (Scripting ability): programming ability in ANY language counts in full; CAD-specific code is not required for a high score.' +
  '\n  5 = years of professional software engineering, or a reusable code-CAD library used by a team.' +
  '\n  4 = professional programming as a main part of the job, or a maintained code-CAD library. Roles that are programming by nature' +
  ' (software, data science, robotics, simulation) count here even when the CV names no language.' +
  '\n  3 = regular scripting that supports a non-software job.' +
  '\n  2 = light or occasional code: macros, small task scripts, analysis scripts, hand-written machine code, a programming course.' +
  '\n  1 = no code, only design tools or spreadsheet-driven configuration.' +
  '\n  0 = no computing skill at all, or the CV says there is no code or scripting.' +
  '\n- comm (Clarity of communication): judge the CV itself and the communication its stated work requires; absence of a writing sample is not a low score.' +
  '\n  5 = documentation, writing or teaching is an explicit, regular part of the work.' +
  '\n  4 = any professional engineering, software, technical or design role, however short the CV' +
  ' (others build on their drawings, plans, code or models), or occasional public technical writing.' +
  '\n  3 = everyone else with a clear CV: students, hobbyists, trades, non-technical jobs.' +
  '\n  2 or lower = only when the CV itself is confusing, contradictory or careless.' +
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
