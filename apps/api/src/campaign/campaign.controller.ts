import { Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CampaignService } from './campaign.service';
import { Roles } from '../auth/auth.decorators';
import { parseCampaignDto } from './dto/campaign.dto';

/**
 * M2 — Task campaigns.
 */
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: unknown) {
    return this.campaigns.create(parseCampaignDto(body));
  }
}
