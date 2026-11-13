import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROBE_ROLLOUTS, MAX_PROBE_ROLLOUTS, parseProbeTaskDto } from './task.dto';

describe('parseProbeTaskDto', () => {
  it('defaults the rollouts and leaves the model to the service', () => {
    expect(parseProbeTaskDto(undefined)).toEqual({ rollouts: DEFAULT_PROBE_ROLLOUTS });
    expect(parseProbeTaskDto({})).toEqual({ rollouts: DEFAULT_PROBE_ROLLOUTS, model: undefined });
  });

  it('takes rollouts from 1 to the service maximum, and a trimmed model', () => {
    expect(parseProbeTaskDto({ rollouts: 1, model: ' qwen ' })).toEqual({ rollouts: 1, model: 'qwen' });
    expect(parseProbeTaskDto({ rollouts: MAX_PROBE_ROLLOUTS }).rollouts).toBe(MAX_PROBE_ROLLOUTS);
  });

  it.each([
    [{ rollouts: 0 }],
    [{ rollouts: MAX_PROBE_ROLLOUTS + 1 }],
    [{ rollouts: 1.5 }],
    [{ rollouts: '3' }],
    [{ model: '' }],
    [{ model: 7 }],
    ['text'],
    [[1]],
  ])('refuses %j', (body) => {
    expect(() => parseProbeTaskDto(body)).toThrow(BadRequestException);
  });
});
