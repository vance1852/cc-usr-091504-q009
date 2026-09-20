import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { CoordinationModule } from './coordination/coordination.module';
import { MentorModule } from './mentor/mentor.module';
import { GuardianModule } from './guardian/guardian.module';
import { StudentModule } from './student/student.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    CoordinationModule,
    MentorModule,
    GuardianModule,
    StudentModule,
  ],
})
export class AppModule {}
