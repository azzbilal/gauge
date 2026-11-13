import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ExpertsService } from './experts.service';
import { Roles } from '../auth/auth.decorators';

@Controller('experts')
export class ExpertsController {
  constructor(private readonly experts: ExpertsService) {}

  @Get()
  @Roles(Role.ADMIN)
  list() {
    return this.experts.list();
  }

  @Post()
  @Roles(Role.ADMIN)
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
