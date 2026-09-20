import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.controller';
import { StudentsModule } from './students/students.controller';
import { AccessModule } from './access/access.controller';
import { MeasuresModule } from './measures/measures.controller';
import { SessionsModule } from './sessions/sessions.controller';
import { BriefingsModule } from './briefings/briefings.controller';
import { PreferencesModule } from './preferences/preferences.controller';
import { GuardianModule } from './guardian/guardian.controller';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    UsersModule,
    StudentsModule,
    AccessModule,
    MeasuresModule,
    SessionsModule,
    BriefingsModule,
    PreferencesModule,
    GuardianModule,
  ],
})
export class AppModule {}
