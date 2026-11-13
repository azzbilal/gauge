import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../review-protocol';
import { parseCreateTaskReviewDto } from './task-review.dto';

const scores = Object.fromEntries(CRITERIA.map((c) => [c, 4]));
const evidence = Object.fromEntries(CRITERIA.map((c) => [c, `${c}: see the spec`]));

const without = (o: Record<string, unknown>, key: string) => {
  const { [key]: _drop, ...rest } = o;
  void _drop;
  return rest;
};

function rejects(body: unknown, message: string) {
  expect(() => parseCreateTaskReviewDto(body)).toThrow(BadRequestException);
  expect(() => parseCreateTaskReviewDto(body)).toThrow(message);
}

describe('parseCreateTaskReviewDto: every criterion scored and evidenced', () => {
  it('accepts a complete review and trims the evidence', () => {
    const padded = { ...evidence, verifiable: '  a checker can decide  ' };
    const dto = parseCreateTaskReviewDto({ scores, evidence: padded });
    expect(dto.scores).toEqual(scores);
    expect(dto.evidence.verifiable).toBe('a checker can decide');
    expect(Object.keys(dto.evidence).sort()).toEqual([...CRITERIA].sort());
  });

  it('keeps only the rubric criteria', () => {
    const dto = parseCreateTaskReviewDto({
      scores: { ...scores, extra: 1 },
      evidence: { ...evidence, extra: 'x' },
    });
    expect(dto.scores).not.toHaveProperty('extra');
    expect(dto.evidence).not.toHaveProperty('extra');
  });

  it.each(CRITERIA)('rejects a review with %s unscored', (c) => {
    rejects({ scores: without(scores, c), evidence }, `scores.${c} must be a whole number`);
  });

  it.each([null, '3', 3.5, -1, 6])('rejects a score of %s', (v) => {
    rejects({ scores: { ...scores, difficulty: v }, evidence }, 'scores.difficulty');
  });

  it.each(CRITERIA)('rejects a review with no evidence for %s', (c) => {
    rejects({ scores, evidence: without(evidence, c) }, `evidence.${c} is required`);
  });

  it.each(['', '   ', '\n\t', 7, null])('rejects evidence of %j', (v) => {
    rejects({ scores, evidence: { ...evidence, unambiguous: v } }, 'evidence.unambiguous is required');
  });

  it('rejects a review without an evidence object', () => {
    rejects({ scores }, 'evidence must be an object');
    rejects({ scores, evidence: ['a', 'b'] }, 'evidence must be an object');
    rejects({ scores, evidence: 'all fine' }, 'evidence must be an object');
  });

  it('rejects a review without a scores object', () => {
    rejects({ evidence }, 'scores must be an object');
  });
});
