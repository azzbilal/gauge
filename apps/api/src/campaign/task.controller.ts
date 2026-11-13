import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { TaskService } from './task.service';
import { parseCreateTaskDto, parsePreviewTaskDto } from './dto/task.dto';
import { parseAdjudicateTaskDto, parseCreateTaskReviewDto } from './dto/task-review.dto';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';

/**
 * M2 — Task authoring and review (docs/pipeline.md).
 * Who acts is always the signed-in user; the role decides what they may do.
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  /** `?queue=1` turns the list into the signed-in user's work queue. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('campaignId') campaignId?: string, @Query('queue') queue?: string) {
    const mine = queue === '1' || queue === 'true';
    return this.tasks.list(user, campaignId || undefined, mine);
  }

  // Declared before ':id' so they are not read as task ids.
  @Get('agreement')
  @Roles(Role.ADMIN)
  agreement(@Query('campaignId') campaignId?: string) {
    return this.tasks.agreement(campaignId || undefined);
  }

  @Get('calibration')
  @Roles(Role.ADMIN)
  calibration(@Query('campaignId') campaignId?: string) {
    return this.tasks.calibration(campaignId || undefined);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.get(id, user);
  }

  /** Layer 2 results stored when the task was created: lint findings and verifier runs. */
  @Get(':id/verification')
  verification(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tasks.verification(id, user);
  }

  @Post()
  @Roles(Role.AUTHOR)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.tasks.create(parseCreateTaskDto(body), user);
  }

  /**
   * Lint and verify a draft without creating anything. Always 200: a verify service
   * that is down is reported as `not_run` in the body, not as an error.
   */
  @Post('preview')
  @Roles(Role.AUTHOR)
  @HttpCode(200)
  preview(@Body() body: unknown) {
    return this.tasks.preview(parsePreviewTaskDto(body));
  }

  @Post(':id/reviews')
  @Roles(Role.REVIEWER)
  review(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.review(id, parseCreateTaskReviewDto(body), user);
  }

  @Post(':id/adjudication')
  @Roles(Role.ADJUDICATOR)
  adjudicate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.adjudicate(id, parseAdjudicateTaskDto(body), user);
  }
}
