import { Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IntakeService } from './intake.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RunIntakeDto } from './dto/run-intake.dto';

/**
 * M1 — Expert Intake Agent.
 * POST /intake/runs scores a CV against a posting and stores the run. Staff only: the
 * body names the expert being screened, the signed-in admin is recorded as the actor.
 */
@Controller('intake')
export class IntakeController {
  constructor(private readonly intakeService: IntakeService) {}

  @Get()
  status() {
    return { module: 'intake', status: 'active', note: 'M1 — expert intake agent' };
  }

  @Post('runs')
  @Roles(Role.ADMIN)
  run(@CurrentUser() user: AuthUser, @Body() dto: RunIntakeDto) {
    return this.intakeService.runIntake(dto, user);
  }
}
