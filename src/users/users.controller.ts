import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { DatabaseService } from '../db/database.service';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { hashPassword } from '../auth/password';
import { id, now } from '../common/util';

class CreateUserDto {
  @IsString()
  login!: string;

  @IsString()
  name!: string;

  @IsString()
  password!: string;

  @IsIn([Role.COORDINATOR, Role.INSTRUCTOR, Role.GUARDIAN, Role.STUDENT])
  role!: Role;

  @IsOptional()
  @IsString({ each: true })
  studentIds?: string[];
}

@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly db: DatabaseService) {}

  /** 协调员创建账号；监护人 / 学生账号可同时绑定学生档案 */
  @Roles(Role.COORDINATOR)
  @Post()
  create(@Body() dto: CreateUserDto) {
    const userId = id('usr');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO users (id, login, password_hash, name, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, dto.login, hashPassword(dto.password), dto.name, dto.role, now());
      for (const studentId of dto.studentIds ?? []) {
        this.db
          .prepare(
            `INSERT INTO user_student_links (user_id, student_id) VALUES (?, ?)`,
          )
          .run(userId, studentId);
      }
    });
    return { id: userId, login: dto.login, name: dto.name, role: dto.role };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    const links = this.db
      .prepare('SELECT student_id FROM user_student_links WHERE user_id = ?')
      .all(user.id) as { student_id: string }[];
    return { ...user, studentIds: links.map((l) => l.student_id) };
  }
}

@Module({
  imports: [JwtModule.register({})],
  controllers: [UsersController],
})
export class UsersModule {}
