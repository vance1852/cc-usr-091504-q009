import {
  Controller,
  ForbiddenException,
  Get,
  Module,
  Param,
  UseGuards,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccessModule } from '../access/access.controller';
import { AccessPolicyService } from '../access/access-policy.service';
import { DatabaseService } from '../db/database.service';
import { today } from '../common/util';

/**
 * 监护人视图：只看本人孩子。
 * 返回措施的“当前版本”、是否仍在分发（过期/同意撤回会如实反映），
 * 以及保留当时依据的已执行记录；看不到诊断性原文以外的他人信息。
 */
@UseGuards(AuthGuard)
@Roles(Role.GUARDIAN)
@Controller('guardian')
export class GuardianController {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  private assertOwnChild(user: AuthUser, studentId: string) {
    if (!this.policy.isStudentLinked(user.id, studentId)) {
      throw new ForbiddenException('只能查看本人绑定的孩子档案');
    }
  }

  @Get('children/:studentId/current-measures')
  currentMeasures(
    @Param('studentId') studentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertOwnChild(user, studentId);
    const consent = this.policy.currentConsent(studentId);
    const rows = this.db
      .prepare(
        `SELECT m.id AS measure_id, m.retired_at,
                mv.id AS version_id, mv.version_no, mv.type, mv.instruction,
                mv.review_date, mv.target_kind, mv.visibility_kind, mv.created_at
           FROM measures m
           JOIN measure_versions mv ON mv.id = m.current_version_id
          WHERE m.student_id = ? ORDER BY mv.type`,
      )
      .all(studentId) as any[];

    return {
      studentId,
      generatedAt: new Date().toISOString(),
      consent: consent
        ? {
            versionId: consent.id,
            versionNo: consent.version_no,
            allowedTypes: consent.allowed_types.split(','),
            note: consent.note,
            createdAt: consent.created_at,
          }
        : null,
      measures: rows.map((v) => {
        const consentAllows = consent?.allowed_types
          .split(',')
          .includes(v.type);
        // 与场次无关的通用有效性；场次级闸门（重评/冲突/授权/适用范围/可见名单）
        // 因场次而异，不在此视图内，由协调员的活动准备结果体现
        const currentlyValid =
          !v.retired_at &&
          v.review_date >= today() &&
          Boolean(consentAllows);
        return {
          measureId: v.measure_id,
          versionId: v.version_id,
          versionNo: v.version_no,
          type: v.type,
          instruction: v.instruction,
          reviewDate: v.review_date,
          target: v.target_kind,
          visibility: v.visibility_kind,
          createdAt: v.created_at,
          validity: {
            retired: Boolean(v.retired_at),
            reviewDue: v.review_date < today(),
            consentAllows: Boolean(consentAllows),
            currentlyValid,
          },
        };
      }),
    };
  }

  /** 已执行记录（保留当时版本与同意快照） */
  @Get('children/:studentId/executions')
  executions(
    @Param('studentId') studentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    this.assertOwnChild(user, studentId);
    return this.db
      .prepare(
        `SELECT l.id, l.session_id, se.name AS session_name, l.measure_id,
                l.measure_version_id, l.type, l.instruction_snapshot,
                l.consent_version_id, l.executed_at, l.note,
                u.name AS executed_by_name
           FROM execution_log l
           JOIN sessions se ON se.id = l.session_id
           JOIN users u ON u.id = l.executed_by
          WHERE l.student_id = ? ORDER BY l.executed_at DESC`,
      )
      .all(studentId);
  }
}

@Module({
  imports: [JwtModule.register({}), AccessModule],
  controllers: [GuardianController],
})
export class GuardianModule {}
