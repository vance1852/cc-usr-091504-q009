import { Module } from '@nestjs/common';
import { CoordinationController } from './coordination.controller';
import { CoordinationService } from './coordination.service';
import { SupportLogic } from '../logic/support.logic';

@Module({
  controllers: [CoordinationController],
  providers: [CoordinationService, SupportLogic],
  exports: [SupportLogic, CoordinationService],
})
export class CoordinationModule {}
