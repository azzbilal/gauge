import { Body, Controller, Get, Post } from '@nestjs/common';
import { CampaignService } from './campaign.service';
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
  create(@Body() body: unknown) {
    return this.campaigns.create(parseCampaignDto(body));
  }
}
