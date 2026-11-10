import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { IntakeModule } from './intake/intake.module';
import { CampaignModule } from './campaign/campaign.module';

/**
 * One NestJS app, three domain modules (no microservices).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    IntakeModule,
    CampaignModule,
  ],
})
export class AppModule {}
