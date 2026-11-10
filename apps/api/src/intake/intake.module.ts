import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';

@Module({
  controllers: [IntakeController],
})
export class IntakeModule {}
