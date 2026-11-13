import { BadRequestException } from '@nestjs/common';

export interface CreateTaskDto {
  campaignId: string;
  prompt: string;
  spec?: string;
  reference?: string;
  /** Present only for gold (calibration) tasks: the known answer. */
  goldExpectedAccept?: boolean;
}

export function parseCreateTaskDto(body: unknown): CreateTaskDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  // The author is the signed-in user; an authorId in the body is ignored.
  const { campaignId, prompt, spec, reference, isGold, goldExpectedAccept } = body as Record<
    string,
    unknown
  >;
  if (typeof campaignId !== 'string' || !campaignId.trim()) {
    throw new BadRequestException('campaignId is required');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequestException('prompt is required');
  }
  if (isGold !== undefined && typeof isGold !== 'boolean') {
    throw new BadRequestException('isGold must be a boolean');
  }
  // A gold task is only useful with its answer (docs/pipeline.md §3).
  if (isGold === true && typeof goldExpectedAccept !== 'boolean') {
    throw new BadRequestException('goldExpectedAccept (boolean) is required when isGold is true');
  }
  if (isGold !== true && goldExpectedAccept !== undefined) {
    throw new BadRequestException('goldExpectedAccept is only allowed when isGold is true');
  }
  return {
    campaignId: campaignId.trim(),
    prompt: prompt.trim(),
    spec: typeof spec === 'string' && spec.trim() ? spec.trim() : undefined,
    reference: typeof reference === 'string' && reference.trim() ? reference.trim() : undefined,
    goldExpectedAccept: isGold === true ? (goldExpectedAccept as boolean) : undefined,
  };
}

/** A draft to check before it is submitted: no campaign or author yet. */
export interface PreviewTaskDto {
  prompt: string;
  spec?: string;
  reference?: string;
}

/**
 * The text is trimmed exactly as parseCreateTaskDto trims it, so the preview checks what
 * a create would store. An empty prompt is allowed: a draft may be checked at any point.
 */
export function parsePreviewTaskDto(body: unknown): PreviewTaskDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { prompt, spec, reference } = body as Record<string, unknown>;
  for (const [name, value] of Object.entries({ prompt, spec, reference })) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new BadRequestException(`${name} must be a string`);
    }
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return { prompt: text(prompt) ?? '', spec: text(spec), reference: text(reference) };
}

/** Most rollouts one probe may ask for; the verify service refuses more (MAX_ROLLOUTS). */
export const MAX_PROBE_ROLLOUTS = 20;
export const DEFAULT_PROBE_ROLLOUTS = 3;

/** POST /tasks/:id/probe. Both fields optional; the model defaults to OLLAMA_MODEL. */
export interface ProbeTaskDto {
  rollouts: number;
  model?: string;
}

export function parseProbeTaskDto(body: unknown): ProbeTaskDto {
  if (body === undefined || body === null) return { rollouts: DEFAULT_PROBE_ROLLOUTS };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { rollouts, model } = body as Record<string, unknown>;
  if (
    rollouts !== undefined &&
    (typeof rollouts !== 'number' ||
      !Number.isInteger(rollouts) ||
      rollouts < 1 ||
      rollouts > MAX_PROBE_ROLLOUTS)
  ) {
    throw new BadRequestException(`rollouts must be an integer from 1 to ${MAX_PROBE_ROLLOUTS}`);
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new BadRequestException('model must be a non-empty string');
  }
  return {
    rollouts: (rollouts as number | undefined) ?? DEFAULT_PROBE_ROLLOUTS,
    model: typeof model === 'string' ? model.trim() : undefined,
  };
}
