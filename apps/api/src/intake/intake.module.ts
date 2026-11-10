import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';
import { AnthropicService } from './anthropic.service';

@Module({
  controllers: [IntakeController],
  providers: [IntakeService, AnthropicService],
})
export class IntakeModule {}
