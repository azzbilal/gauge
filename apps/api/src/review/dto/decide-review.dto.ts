import { BadRequestException } from '@nestjs/common';

export type ReviewVerdictInput = 'approve' | 'reject';

export interface DecideReviewDto {
  verdict: ReviewVerdictInput;
  reason?: string;
}

/**
 * No global ValidationPipe in this app, so the body is checked by hand.
 * Anything malformed is a 400, never a 500. The reviewer is the signed-in user; a
 * reviewerId in the body is ignored.
 */
export function parseDecideReviewDto(body: unknown): DecideReviewDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { verdict, reason } = body as Record<string, unknown>;

  if (verdict !== 'approve' && verdict !== 'reject') {
    throw new BadRequestException('verdict must be "approve" or "reject"');
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new BadRequestException('reason must be a string');
  }

  return {
    verdict,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : undefined,
  };
}
