import { BadRequestException } from '@nestjs/common';

export interface CreateTaskDto {
  campaignId: string;
  authorId: string;
  prompt: string;
  spec?: string;
  reference?: string;
}

export function parseCreateTaskDto(body: unknown): CreateTaskDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { campaignId, authorId, prompt, spec, reference } = body as Record<string, unknown>;
  if (typeof campaignId !== 'string' || !campaignId.trim()) {
    throw new BadRequestException('campaignId is required');
  }
  if (typeof authorId !== 'string' || !authorId.trim()) {
    throw new BadRequestException('authorId is required');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequestException('prompt is required');
  }
  return {
    campaignId: campaignId.trim(),
    authorId: authorId.trim(),
    prompt: prompt.trim(),
    spec: typeof spec === 'string' && spec.trim() ? spec.trim() : undefined,
    reference: typeof reference === 'string' && reference.trim() ? reference.trim() : undefined,
  };
}
