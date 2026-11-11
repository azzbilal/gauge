import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ExpertsService } from './experts.service';

@Controller('experts')
export class ExpertsController {
  constructor(private readonly experts: ExpertsService) {}

  @Get()
  list() {
    return this.experts.list();
  }

  @Post()
  create(@Body() body: unknown) {
    const { name, domain } = (body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) {
      throw new BadRequestException('name is required');
    }
    return this.experts.create({
      name: name.trim(),
      domain: typeof domain === 'string' && domain.trim() ? domain.trim() : undefined,
    });
  }
}
