import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { IntakeModule } from './intake/intake.module';
import { CampaignModule } from './campaign/campaign.module';

/**
 * One NestJS app, three domain modules (no microservices).
 */
@Module({
  imports: [HealthModule, IntakeModule, CampaignModule],
})
export class AppModule {}
