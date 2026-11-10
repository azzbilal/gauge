import { Controller, Get } from '@nestjs/common';

/**
 * M2 — Task pipeline and campaign (placeholder).
 * Day 4–7: task templates, assignment, review, gold tasks, inter-annotator
 * agreement.
 */
@Controller('campaigns')
export class CampaignController {
  @Get()
  status() {
    return {
      module: 'campaign',
      status: 'stub',
      note: 'M2 — task pipeline and campaign (day 4–7)',
    };
  }
}
