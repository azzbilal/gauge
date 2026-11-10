import { Body, Controller, Get, Post } from '@nestjs/common';

/**
 * M1 — Expert Intake Agent (placeholder).
 * Day 2–3: reads a CV + a posting, scores fit per rubric criterion with an
 * evidence quote and a confidence, and routes low-confidence cases to a human.
 */
@Controller('intake')
export class IntakeController {
  @Get()
  status() {
    return {
      module: 'intake',
      status: 'stub',
      note: 'M1 — expert intake agent (day 2–3)',
    };
  }

  @Post('runs')
  createRun(@Body() body: unknown) {
    return {
      accepted: true,
      input: body,
      note: 'stub — will score CV vs posting via Claude structured outputs',
    };
  }
}
