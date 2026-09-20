import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
})
export class AuthModule {}
