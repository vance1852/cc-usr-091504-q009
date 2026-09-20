import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { StudentService } from './student.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../common/domain';

class PreferenceDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

@Roles('student')
@Controller('student')
export class StudentController {
  constructor(private readonly svc: StudentService) {}

  @Post('preferences')
  add(@CurrentUser() u: AuthUser, @Body() dto: PreferenceDto) {
    return this.svc.addPreference(u, dto.text);
  }

  @Get('preferences')
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listMyPreferences(u);
  }
}
