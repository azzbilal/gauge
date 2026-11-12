import { Module } from '@nestjs/common';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { VerifyClient } from '../verify/verify.client';

@Module({
  controllers: [CampaignController, TaskController],
  providers: [CampaignService, TaskService, VerifyClient],
})
export class CampaignModule {}
