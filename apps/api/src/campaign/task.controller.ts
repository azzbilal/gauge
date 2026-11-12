import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TaskService } from './task.service';
import { parseCreateTaskDto } from './dto/task.dto';
import { parseAdjudicateTaskDto, parseCreateTaskReviewDto } from './dto/task-review.dto';

/**
 * M2 — Task authoring and review (docs/pipeline.md).
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  /** `?reviewerId=` turns the list into that reviewer's work queue. */
  @Get()
  list(@Query('campaignId') campaignId?: string, @Query('reviewerId') reviewerId?: string) {
    return this.tasks.list(campaignId || undefined, reviewerId?.trim() || undefined);
  }

  // Declared before ':id' so they are not read as task ids.
  @Get('agreement')
  agreement(@Query('campaignId') campaignId?: string) {
    return this.tasks.agreement(campaignId || undefined);
  }

  @Get('calibration')
  calibration(@Query('campaignId') campaignId?: string) {
    return this.tasks.calibration(campaignId || undefined);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tasks.get(id);
  }

  /** Layer 2 results stored when the task was created: lint findings and verifier runs. */
  @Get(':id/verification')
  verification(@Param('id') id: string) {
    return this.tasks.verification(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.tasks.create(parseCreateTaskDto(body));
  }

  @Post(':id/reviews')
  review(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.review(id, parseCreateTaskReviewDto(body));
  }

  @Post(':id/adjudication')
  adjudicate(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.adjudicate(id, parseAdjudicateTaskDto(body));
  }
}
