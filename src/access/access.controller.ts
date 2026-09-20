import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { DatabaseService } from '../db/database.service';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role, ALL_MEASURE_TYPES } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccessPolicyService } from './access-policy.service';
import { id, now, toCsv } from '../common/util';

class CreateMaterialDto {
  @IsString()
  studentId!: string;

  @IsString()
  kind!: string;

  @IsString()
  title!: string;

  @IsString()
  content!: string;
}

class CreateGrantDto {
  @IsString()
  studentId!: string;

  @IsString()
  granteeId!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(ALL_MEASURE_TYPES, { each: true })
  types?: string[];
}

class CreateConsentDto {
  @IsString()
  studentId!: string;

  @IsArray()
  @IsString({ each: true })
  @IsIn(ALL_MEASURE_TYPES, { each: true })
  allowedTypes!: string[];

  @IsOptional()
  @IsString()
  note?: string;
}

@UseGuards(AuthGuard)
@Controller()
export class AccessController {
  constructor(
    private readonly db: DatabaseService,
    private readonly policy: AccessPolicyService,
  ) {}

  // ---------- 诊断性原始材料 ----------

  /** 上传原始材料：仅协调员 */
  @Roles(Role.COORDINATOR)
  @Post('materials')
  createMaterial(@Body() dto: CreateMaterialDto, @CurrentUser() user: AuthUser) {
    this.policy.requireStudent(dto.studentId);
    const materialId = id('mat');
    this.db
      .prepare(
        `INSERT INTO raw_materials (id, student_id, kind, title, content, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        materialId,
        dto.studentId,
        dto.kind,
        dto.title,
        dto.content,
        user.id,
        now(),
      );
    return { id: materialId };
  }

  /**
   * 材料清单只返回元数据，不返回诊断原文。
   * 导师任何情况下都不可见原始材料（清单也不可见）。
   */
  @Get('materials')
  listMaterials(
    @Query('studentId') studentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    if (user.role === Role.INSTRUCTOR) {
      throw new ForbiddenException('导师不得访问原始健康材料');
    }
    this.policy.assertFamilyAccess(user.id, user.role, studentId);
    return this.db
      .prepare(
        `SELECT m.id, m.student_id, m.kind, m.title, m.created_by, m.created_at
           FROM raw_materials m WHERE m.student_id = ? ORDER BY m.created_at`,
      )
      .all(studentId);
  }

  /**
   * 读取原文：协调员须持有针对该学生的有效授权（任一类即可），
   * 监护人须为绑定档案；导师一律拒绝。
   */
  @Get('materials/:mid')
  getMaterial(@Param('mid') materialId: string, @CurrentUser() user: AuthUser) {
    const material = this.db
      .prepare('SELECT * FROM raw_materials WHERE id = ?')
      .get(materialId) as
      | {
          id: string;
          student_id: string;
          kind: string;
          title: string;
          content: string;
          created_at: string;
        }
      | undefined;
    if (!material) throw new NotFoundException();

    if (user.role === Role.INSTRUCTOR) {
      throw new ForbiddenException('导师不得查看诊断性原文');
    }
    if (user.role === Role.COORDINATOR) {
      const granted = ALL_MEASURE_TYPES.some((t) =>
        this.policy.hasActiveGrant(material.student_id, user.id, t),
      );
      if (!granted) {
        throw new ForbiddenException('缺少针对该学生的材料访问授权');
      }
    } else {
      this.policy.assertFamilyAccess(user.id, user.role, material.student_id);
    }
    return material;
  }

  // ---------- 转化授权 ----------

  /** 授予某协调员把原始材料转化为措施的权限（types 缺省 = 全部类型） */
  @Roles(Role.COORDINATOR)
  @Post('grants')
  createGrant(@Body() dto: CreateGrantDto, @CurrentUser() user: AuthUser) {
    this.policy.requireStudent(dto.studentId);
    const grantee = this.db
      .prepare("SELECT id, role FROM users WHERE id = ?")
      .get(dto.granteeId) as { id: string; role: string } | undefined;
    if (!grantee) throw new BadRequestException('被授权人不存在');

    const grantId = id('grn');
    this.db
      .prepare(
        `INSERT INTO grants (id, student_id, grantee_id, scope, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grantId,
        dto.studentId,
        dto.granteeId,
        dto.types?.length ? toCsv(dto.types) : 'ALL',
        user.id,
        now(),
      );
    return { id: grantId };
  }

  /** 撤回授权：撤回后旧措施立即停止向导师分发 */
  @Roles(Role.COORDINATOR)
  @Delete('grants/:gid')
  revokeGrant(@Param('gid') grantId: string, @CurrentUser() user: AuthUser) {
    const grant = this.db
      .prepare('SELECT * FROM grants WHERE id = ?')
      .get(grantId) as { revoked_at: string | null } | undefined;
    if (!grant) throw new NotFoundException();
    if (grant.revoked_at) return { id: grantId, revokedAt: grant.revoked_at };
    const ts = now();
    this.db
      .prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(ts, grantId);
    return { id: grantId, revokedAt: ts, revokedBy: user.id };
  }

  @Roles(Role.COORDINATOR)
  @Get('grants')
  listGrants(@Query('studentId') studentId: string) {
    return this.db
      .prepare(
        `SELECT g.id, g.student_id, g.grantee_id, u.name AS grantee_name,
                g.scope, g.granted_at, g.revoked_at
           FROM grants g JOIN users u ON u.id = g.grantee_id
          WHERE g.student_id = ? ORDER BY g.granted_at`,
      )
      .all(studentId);
  }

  // ---------- 监护人同意（版本化） ----------

  /**
   * 写入新一版同意范围：监护人（本人孩子）或协调员代为登记。
   * 每次都产生新版本；分发始终读取最新版本，旧版本立即失效。
   */
  @Post('consent')
  createConsent(@Body() dto: CreateConsentDto, @CurrentUser() user: AuthUser) {
    this.policy.requireStudent(dto.studentId);
    if (user.role === Role.GUARDIAN || user.role === Role.STUDENT) {
      if (!this.policy.isStudentLinked(user.id, dto.studentId)) {
        throw new ForbiddenException('只能调整本人孩子的同意范围');
      }
    }
    if (user.role === Role.INSTRUCTOR) {
      throw new ForbiddenException('导师不得变更同意范围');
    }
    const latest = this.policy.currentConsent(dto.studentId);
    const versionNo = (latest?.version_no ?? 0) + 1;
    const consentId = id('cns');
    this.db
      .prepare(
        `INSERT INTO consent_versions
           (id, student_id, version_no, allowed_types, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        consentId,
        dto.studentId,
        versionNo,
        toCsv(dto.allowedTypes),
        dto.note ?? null,
        user.id,
        now(),
      );
    return {
      id: consentId,
      studentId: dto.studentId,
      versionNo,
      allowedTypes: dto.allowedTypes,
    };
  }

  /** 同意版本历史：协调员或绑定监护人 */
  @Get('consent/:studentId')
  listConsent(@Param('studentId') studentId: string, @CurrentUser() user: AuthUser) {
    this.policy.assertFamilyAccess(user.id, user.role, studentId);
    if (user.role === Role.INSTRUCTOR) {
      throw new ForbiddenException();
    }
    return this.db
      .prepare(
        `SELECT id, version_no, allowed_types, note, created_by, created_at
           FROM consent_versions WHERE student_id = ? ORDER BY version_no DESC`,
      )
      .all(studentId);
  }
}

@Module({
  imports: [JwtModule.register({})],
  providers: [AccessPolicyService],
  controllers: [AccessController],
  exports: [AccessPolicyService],
})
export class AccessModule {}
