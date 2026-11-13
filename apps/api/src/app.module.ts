import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { IntakeModule } from './intake/intake.module';
import { CampaignModule } from './campaign/campaign.module';
import { ReviewModule } from './review/review.module';
import { ExpertsModule } from './experts/experts.module';
import { AuthModule } from './auth/auth.module';

/**
 * One NestJS app, domain modules (no microservices).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    HealthModule,
    IntakeModule,
    CampaignModule,
    ReviewModule,
    ExpertsModule,
  ],
})
export class AppModule {}
