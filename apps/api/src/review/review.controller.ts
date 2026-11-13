import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ReviewService } from './review.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { parseDecideReviewDto } from './dto/decide-review.dto';

/**
 * Human-in-the-loop review of low-confidence intake runs.
 */
@Controller('review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('queue')
  @Roles(Role.REVIEWER)
  queue() {
    return this.reviewService.listQueue();
  }

  @Post('queue/:id/decide')
  @Roles(Role.REVIEWER)
  decide(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.reviewService.decide(id, parseDecideReviewDto(body), user);
  }

  @Get('export')
  @Roles(Role.ADMIN)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="review-decisions.csv"')
  export() {
    return this.reviewService.exportCsv();
  }
}
