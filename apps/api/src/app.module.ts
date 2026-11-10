import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { IntakeModule } from './intake/intake.module';
import { CampaignModule } from './campaign/campaign.module';
import { ReviewModule } from './review/review.module';

/**
 * One NestJS app, domain modules (no microservices).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    IntakeModule,
    CampaignModule,
    ReviewModule,
  ],
})
export class AppModule {}
