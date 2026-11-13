import { IntakeAssessment } from './llm/types';

/** Below this confidence (overall, or on any one criterion) a run goes to a human. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** The lowest confidence in an assessment: the overall one or any criterion's. */
export function minConfidence(assessment: Pick<IntakeAssessment, 'overallConfidence' | 'scores'>): number {
  return Math.min(assessment.overallConfidence, ...assessment.scores.map((s) => s.confidence));
}

/** Does this assessment go to the human review queue? */
export function needsHumanReview(assessment: Pick<IntakeAssessment, 'overallConfidence' | 'scores'>): boolean {
  return minConfidence(assessment) < LOW_CONFIDENCE_THRESHOLD;
}
