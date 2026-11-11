import { BadRequestException } from '@nestjs/common';

// Must match docs/pipeline.md §2.
const CRITERIA = ['verifiable', 'unambiguous', 'correct_reference', 'complete_constraints', 'difficulty'];
const ANONYMOUS_REVIEWER = 'anonymous-reviewer';

// Acceptance bar (docs/pipeline.md §2): every criterion >= 3, and verifiable >= 4.
export const ACCEPTANCE_MIN = 3;
export const VERIFIABLE_MIN = 4;

export interface CreateTaskReviewDto {
  reviewerId: string;
  scores: Record<string, number>;
}

/** The rubric decides acceptance, not the client. */
export function isAccepted(scores: Record<string, number>): boolean {
  return (
    Object.values(scores).every((v) => v >= ACCEPTANCE_MIN) &&
    (scores['verifiable'] ?? 0) >= VERIFIABLE_MIN
  );
}

export function parseCreateTaskReviewDto(body: unknown): CreateTaskReviewDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { reviewerId, scores } = body as Record<string, unknown>;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new BadRequestException('scores must be an object');
  }
  const s = scores as Record<string, unknown>;
  for (const c of CRITERIA) {
    const v = s[c];
    if (typeof v !== 'number' || v < 0 || v > 5) {
      throw new BadRequestException(`scores.${c} must be a number from 0 to 5`);
    }
  }
  return {
    reviewerId:
      typeof reviewerId === 'string' && reviewerId.trim() ? reviewerId.trim() : ANONYMOUS_REVIEWER,
    scores: Object.fromEntries(CRITERIA.map((c) => [c, s[c] as number])),
  };
}
