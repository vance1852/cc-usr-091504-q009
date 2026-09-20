import { Module } from '@nestjs/common';
import { GuardianController } from './guardian.controller';
import { GuardianService } from './guardian.service';
import { CoordinationModule } from '../coordination/coordination.module';

@Module({
  imports: [CoordinationModule],
  controllers: [GuardianController],
  providers: [GuardianService],
})
export class GuardianModule {}
