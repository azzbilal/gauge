import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCampaignDto } from './dto/campaign.dto';

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
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
