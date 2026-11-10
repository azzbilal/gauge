import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { llmProvider } from './llm/llm.provider';

@Module({
  controllers: [IntakeController],
  providers: [IntakeService, llmProvider],
})
export class IntakeModule {}
