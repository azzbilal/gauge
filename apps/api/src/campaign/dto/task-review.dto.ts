import { BadRequestException } from '@nestjs/common';
import { CRITERIA, Scores } from '../review-protocol';

// The rubric and its acceptance bar live in review-protocol.ts; re-exported here
// so existing imports keep working.
export { ACCEPTANCE_MIN, VERIFIABLE_MIN, isAccepted } from '../review-protocol';

export interface CreateTaskReviewDto {
  /** The reviewer's Expert id. Required: a review without an identity cannot be
   *  paired, calibrated, or kept independent of the author. */
  reviewerId: string;
  scores: Scores;
}

export interface AdjudicateTaskDto {
  /** The adjudicator's Expert id. */
  adjudicatorId: string;
  verdict: 'accept' | 'reject';
  reason: string;
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${name} is required`);
  }
  return value.trim();
}

export function parseCreateTaskReviewDto(body: unknown): CreateTaskReviewDto {
  const { reviewerId, scores } = asObject(body);
  const reviewer = requiredString(reviewerId, 'reviewerId');
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new BadRequestException('scores must be an object');
  }
  const s = scores as Record<string, unknown>;
  for (const c of CRITERIA) {
    const v = s[c];
    // Whole numbers only: the rubric is a 0-5 scale and agreement is measured on it.
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 5) {
      throw new BadRequestException(`scores.${c} must be a whole number from 0 to 5`);
    }
  }
  return {
    reviewerId: reviewer,
    scores: Object.fromEntries(CRITERIA.map((c) => [c, s[c] as number])),
  };
}

export function parseAdjudicateTaskDto(body: unknown): AdjudicateTaskDto {
  const { adjudicatorId, verdict, reason } = asObject(body);
  if (verdict !== 'accept' && verdict !== 'reject') {
    throw new BadRequestException('verdict must be "accept" or "reject"');
  }
  return {
    adjudicatorId: requiredString(adjudicatorId, 'adjudicatorId'),
    verdict,
    // An adjudication overrides one reviewer; the record must say why.
    reason: requiredString(reason, 'reason'),
  };
}
