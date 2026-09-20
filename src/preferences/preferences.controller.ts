import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { IsIn, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { PreferenceVisibility, Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccessModule } from '../access/access.controller';
import { AccessPolicyService } from '../access/access-policy.service';
import { DatabaseService } from '../db/database.service';
import { id, now } from '../common/util';

class CreatePreferenceDto {
  @IsString()
  studentId!: string;

  @IsString()
  text!: string;

  @IsIn([PreferenceVisibility.PRIVATE, PreferenceVisibility.SHARE_INSTRUCTOR])
  visibility!: PreferenceVisibility;
}

@UseGuards(AuthGuard)
@Controller('preferences')
export class PreferencesController {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  /**
   * 学生表达偏好，可标记为不愿公开（PRIVATE）。
   * PRIVATE 偏好只对协调员和学生本人可见，绝不进入导师简报。
   */
  @Post()
  create(@Body() dto: CreatePreferenceDto, @CurrentUser() user: AuthUser) {
    this.policy.requireStudent(dto.studentId);
    if (user.role === Role.STUDENT) {
      if (!this.policy.isStudentLinked(user.id, dto.studentId)) {
        throw new ForbiddenException('只能为本人档案表达偏好');
      }
    } else if (user.role !== Role.COORDINATOR) {
      throw new ForbiddenException('只有学生本人或协调员可以登记偏好');
    }
    if (!dto.text?.trim()) throw new ForbiddenException('偏好内容不能为空');

    const prefId = id('prf');
    this.db
      .prepare(
        `INSERT INTO student_preferences (id, student_id, text, visibility, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(prefId, dto.studentId, dto.text.trim(), dto.visibility, user.id, now());
    return { id: prefId, visibility: dto.visibility };
  }

  @Get()
  list(@Query('studentId') studentId: string, @CurrentUser() user: AuthUser) {
    this.policy.assertFamilyAccess(user.id, user.role, studentId);
    if (user.role === Role.INSTRUCTOR) {
      throw new ForbiddenException();
    }
    // 监护人只能看到学生愿意公开的偏好；私密偏好尊重学生本人意愿
    const sql =
      user.role === Role.GUARDIAN
        ? `SELECT id, student_id, text, visibility, created_at
             FROM student_preferences
            WHERE student_id = ? AND visibility = 'SHARE_INSTRUCTOR'
            ORDER BY created_at`
        : `SELECT id, student_id, text, visibility, created_at
             FROM student_preferences
            WHERE student_id = ? ORDER BY created_at`;
    return this.db.prepare(sql).all(studentId);
  }
}

@Module({
  imports: [JwtModule.register({}), AccessModule],
  controllers: [PreferencesController],
})
export class PreferencesModule {}
