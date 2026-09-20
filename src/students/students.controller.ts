import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { JwtModule } from '@nestjs/jwt';
import { Module } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { id, now } from '../common/util';

class CreateStudentDto {
  @IsString()
  name!: string;
}

@UseGuards(AuthGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly db: DatabaseService) {}

  @Roles(Role.COORDINATOR)
  @Post()
  create(@Body() dto: CreateStudentDto) {
    const studentId = id('stu');
    this.db
      .prepare('INSERT INTO students (id, name, created_at) VALUES (?, ?, ?)')
      .run(studentId, dto.name, now());
    return { id: studentId, name: dto.name };
  }

  /**
   * 名单可见范围：
   * - 协调员：全部
   * - 导师：自己场次的报名学生
   * - 监护人 / 学生：仅与本人账号绑定的档案
   */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    if (user.role === Role.COORDINATOR) {
      return this.db.prepare('SELECT id, name FROM students ORDER BY name').all();
    }
    if (user.role === Role.INSTRUCTOR) {
      return this.db
        .prepare(
          `SELECT DISTINCT s.id, s.name
             FROM students s
             JOIN enrollments e ON e.student_id = s.id
             JOIN sessions se ON se.id = e.session_id
            WHERE se.instructor_id = ?
            ORDER BY s.name`,
        )
        .all(user.id);
    }
    return this.db
      .prepare(
        `SELECT s.id, s.name
           FROM students s
           JOIN user_student_links l ON l.student_id = s.id
          WHERE l.user_id = ?
          ORDER BY s.name`,
      )
      .all(user.id);
  }

  @Get(':id')
  get(@Param('id') studentId: string, @CurrentUser() user: AuthUser) {
    const student = this.db
      .prepare('SELECT id, name FROM students WHERE id = ?')
      .get(studentId);
    if (!student) return null;
    if (
      (user.role === Role.GUARDIAN || user.role === Role.STUDENT) &&
      !this.linked(user.id, studentId)
    ) {
      return null;
    }
    return student;
  }

  private linked(userId: string, studentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 AS hit FROM user_student_links WHERE user_id = ? AND student_id = ?',
        )
        .get(userId, studentId),
    );
  }
}

@Module({
  imports: [JwtModule.register({})],
  controllers: [StudentsController],
})
export class StudentsModule {}
