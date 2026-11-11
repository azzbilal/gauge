import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExpertsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.expert.findMany({ orderBy: { createdAt: 'desc' } });
  }

  create(dto: { name: string; domain?: string }) {
    return this.prisma.expert.create({
      data: { name: dto.name, domain: dto.domain ?? 'CAD' },
    });
  }
}
