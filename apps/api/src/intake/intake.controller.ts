import { Body, Controller, Get, Post } from '@nestjs/common';
import { IntakeService } from './intake.service';
import { RunIntakeDto } from './dto/run-intake.dto';

/**
 * M1 — Expert Intake Agent.
 * POST /intake/runs scores a CV against a posting and stores the run.
 */
@Controller('intake')
export class IntakeController {
  constructor(private readonly intakeService: IntakeService) {}

  @Get()
  status() {
    return { module: 'intake', status: 'active', note: 'M1 — expert intake agent' };
  }

  @Post('runs')
  run(@Body() dto: RunIntakeDto) {
    return this.intakeService.runIntake(dto);
  }
}
