import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.decorators';
import { CreateCampaignDto } from './dto/campaign.dto';
import { visibleWhere } from './task-visibility';

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Each campaign's task count is what this viewer can see of it, by the same rule as the
   * task list: counting gold would expose how much hidden gold there is, and counting only
   * normal tasks would leave a reviewer's list longer than the count by their gold clones,
   * which stay in the list after review.
   */
  list(viewer: AuthUser) {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: { where: visibleWhere(viewer) } } } },
    });
  }

  create(dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        name: dto.name,
        targetCount: dto.targetCount,
        specVersion: dto.specVersion,
      },
    });
  }
}
