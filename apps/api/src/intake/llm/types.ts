export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  weight?: number;
}

export interface CriterionScore {
  criterionId: string;
  label: string;
  score: number;
  evidence: string;
  confidence: number;
}

export interface IntakeAssessment {
  scores: CriterionScore[];
  overallConfidence: number;
  /** Free-text rationale, when the provider returns one. */
  reasoning?: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Concrete model id that produced this assessment. */
  model: string;
  /** Estimated USD cost of the call (0 for local models). */
  costUsd: number;
}

/** Raw shape every provider must produce before normalisation. */
export interface RawScores {
  reasoning?: string;
  scores: { criterionId: string; score: number; evidence: string; confidence: number }[];
  overallConfidence: number;
}

/**
 * A pluggable CV-scoring backend. Selected at boot via LLM_PROVIDER.
 */
export interface LlmScoringProvider {
  /** Short provider name, e.g. "ollama" or "anthropic". */
  readonly name: string;
  /** Prompt version stored on every run; bump when the prompt changes. */
  readonly promptVersion: string;
  scoreCv(cv: string, posting: string, criteria: RubricCriterion[]): Promise<IntakeAssessment>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
