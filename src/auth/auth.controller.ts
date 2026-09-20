import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { IsString } from 'class-validator';
import { DatabaseService } from '../db/database.service';
import { JwtService } from '@nestjs/jwt';
import { verifyPassword } from './password';

class LoginDto {
  @IsString()
  login!: string;

  @IsString()
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    const user = this.db
      .prepare('SELECT * FROM users WHERE login = ?')
      .get(dto.login) as
      | {
          id: string;
          login: string;
          name: string;
          role: string;
          password_hash: string;
        }
      | undefined;
    if (!user || !verifyPassword(dto.password, user.password_hash)) {
      throw new UnauthorizedException('账号或口令错误');
    }
    const payload = {
      id: user.id,
      login: user.login,
      name: user.name,
      role: user.role,
    };
    return {
      token: this.jwt.sign(payload, {
        secret: process.env.JWT_SECRET || 'dev-secret',
      }),
      user: payload,
    };
  }
}
