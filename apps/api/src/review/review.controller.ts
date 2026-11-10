import { Body, Controller, Get, Header, Param, Post } from '@nestjs/common';
import { ReviewService } from './review.service';
import { parseDecideReviewDto } from './dto/decide-review.dto';

/**
 * Human-in-the-loop review of low-confidence intake runs.
 */
@Controller('review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('queue')
  queue() {
    return this.reviewService.listQueue();
  }

  @Post('queue/:id/decide')
  decide(@Param('id') id: string, @Body() body: unknown) {
    return this.reviewService.decide(id, parseDecideReviewDto(body));
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="review-decisions.csv"')
  export() {
    return this.reviewService.exportCsv();
  }
}
