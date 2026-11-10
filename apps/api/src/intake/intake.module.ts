import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { llmProvider } from './llm/llm.provider';
import { SlackModule } from '../slack/slack.module';

@Module({
  imports: [SlackModule],
  controllers: [IntakeController],
  providers: [IntakeService, llmProvider],
})
export class IntakeModule {}
