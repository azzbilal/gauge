import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { TaskService } from './task.service';
import { parseCreateTaskDto } from './dto/task.dto';
import { parseCreateTaskReviewDto } from './dto/task-review.dto';

/**
 * M2 — Task authoring and review.
 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get()
  list(@Query('campaignId') campaignId?: string) {
    return this.tasks.list(campaignId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tasks.get(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.tasks.create(parseCreateTaskDto(body));
  }

  @Post(':id/reviews')
  review(@Param('id') id: string, @Body() body: unknown) {
    return this.tasks.review(id, parseCreateTaskReviewDto(body));
  }
}
