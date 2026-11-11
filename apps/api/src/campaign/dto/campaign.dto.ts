import { BadRequestException } from '@nestjs/common';

export interface CreateCampaignDto {
  name: string;
  targetCount: number;
  specVersion: string;
}

export function parseCampaignDto(body: unknown): CreateCampaignDto {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const { name, targetCount, specVersion } = body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    throw new BadRequestException('name is required');
  }
  return {
    name: name.trim(),
    targetCount: typeof targetCount === 'number' ? targetCount : 0,
    specVersion:
      typeof specVersion === 'string' && specVersion.trim() ? specVersion.trim() : 'v1',
  };
}
