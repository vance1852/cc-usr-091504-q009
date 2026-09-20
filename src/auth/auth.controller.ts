import { Body, Controller, Post } from '@nestjs/common';
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { Role } from '../common/domain';
import { Public } from './public.decorator';

class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  name!: string;

  @IsIn(['coordinator', 'mentor', 'guardian', 'student'])
  role!: Role;
}

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
