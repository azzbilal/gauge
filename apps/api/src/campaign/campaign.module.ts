import { Module } from '@nestjs/common';
import { CampaignController } from './campaign.controller';

@Module({
  controllers: [CampaignController],
})
export class CampaignModule {}
