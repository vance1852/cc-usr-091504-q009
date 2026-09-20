import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CoordinationService } from './coordination.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser, MeasureType, ScopeType, VersionStatus } from '../common/domain';

class ScopeDto {
  @IsIn(['activity', 'program', 'global'])
  scopeType!: ScopeType;

  @IsOptional()
  @IsString()
  activityId?: string;

  @IsOptional()
  @IsString()
  programCode?: string;
}

class CreateStudentDto {
  @IsString()
  name!: string;
}

class LinkGuardianDto {
  @IsString()
  guardianUserId!: string;
}

class LinkStudentUserDto {
  @IsString()
  userId!: string;
}

class SourceMaterialDto {
  @IsIn(['medical', 'educational', 'guardian_note', 'student_preference'])
  kind!: 'medical' | 'educational' | 'guardian_note' | 'student_preference';

  @IsString()
  title!: string;

  @IsString()
  rawText!: string;
}

class AuthorizationDto {
  @IsString()
  scope!: string;
}

class ActivityDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  programCode?: string;

  @IsString()
  contentSummary!: string;

  @IsOptional()
  @IsArray()
  allergens?: string[];

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsArray()
  studentIds?: string[];

  @IsOptional()
  @IsArray()
  mentorIds?: string[];
}

class ActivityContentDto {
  @IsOptional()
  @IsString()
  contentSummary?: string;

  @IsOptional()
  @IsArray()
  allergens?: string[];
}

class CreateMeasureDto {
  @IsString()
  sourceMaterialId!: string;

  @IsIn(['seating', 'communication', 'dietary', 'accompaniment'])
  type!: MeasureType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeDto)
  scopes!: ScopeDto[];

  @IsString()
  instruction!: string;

  @IsOptional()
  @IsObject()
  constraints?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsString()
  consentScope!: string;

  @IsOptional()
  @IsString()
  consentGrantId?: string;

  @IsOptional()
  @IsIn(['active', 'draft'])
  status?: VersionStatus;

  @IsOptional()
  @IsString()
  authorizationId?: string;
}

class ReviseMeasureDto {
  @IsString()
  instruction!: string;

  @IsOptional()
  @IsObject()
  constraints?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsString()
  consentScope!: string;

  @IsOptional()
  @IsString()
  consentGrantId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeDto)
  scopes?: ScopeDto[];
}

class ConfirmAlternativeDto {
  @IsString()
  instruction!: string;

  @IsOptional()
  @IsObject()
  constraints?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  reviewDate?: string;

  @IsString()
  consentScope!: string;

  @IsOptional()
  @IsString()
  consentGrantId?: string;
}

class ResolveConflictDto {
  @IsString()
  note!: string;
}

@Roles('coordinator')
@Controller('coordination')
export class CoordinationController {
  constructor(private readonly svc: CoordinationService) {}

  // ---- 学生 ----
  @Post('students')
  createStudent(@CurrentUser() u: AuthUser, @Body() dto: CreateStudentDto) {
    return this.svc.createStudent(u, dto.name);
  }

  @Put('students/:id/guardian')
  linkGuardian(@Param('id') id: string, @Body() dto: LinkGuardianDto) {
    return this.svc.linkGuardian(id, dto.guardianUserId);
  }

  @Put('students/:id/student-user')
  linkStudentUser(@Param('id') id: string, @Body() dto: LinkStudentUserDto) {
    return this.svc.linkStudentUser(id, dto.userId);
  }

  // ---- 原始材料(诊断性原文,仅协调员) ----
  @Post('students/:id/source-materials')
  addSource(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SourceMaterialDto) {
    return this.svc.addSourceMaterial(u, id, dto);
  }

  @Get('students/:id/source-materials')
  listSources(@Param('id') id: string) {
    return this.svc.listSourceMaterials(id);
  }

  @Get('students/:id/preferences')
  listPreferences(@Param('id') id: string) {
    return this.svc.listPreferences(id);
  }

  // ---- 授权 ----
  @Post('authorizations')
  grantAuth(@CurrentUser() u: AuthUser, @Body() dto: AuthorizationDto) {
    return this.svc.grantAuthorization(u, dto.scope);
  }

  @Post('authorizations/:id/revoke')
  revokeAuth(@Param('id') id: string) {
    return this.svc.revokeAuthorization(id);
  }

  // ---- 活动 ----
  @Post('activities')
  createActivity(@CurrentUser() u: AuthUser, @Body() dto: ActivityDto) {
    return this.svc.createActivity(u, dto);
  }

  @Get('activities')
  listActivities() {
    return this.svc.listActivities();
  }

  @Get('activities/:id')
  getActivity(@Param('id') id: string) {
    return this.svc.getActivityView(id);
  }

  @Put('activities/:id/content')
  updateContent(@Param('id') id: string, @Body() dto: ActivityContentDto) {
    return this.svc.updateActivityContent(id, dto);
  }

  @Get('overlaps')
  overlaps() {
    return this.svc.crossActivityOverlaps();
  }

  // ---- 措施 ----
  @Post('students/:id/measures')
  createMeasure(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateMeasureDto,
  ) {
    return this.svc.createMeasure(u, id, dto);
  }

  @Post('measures/:id/revise')
  revise(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviseMeasureDto,
  ) {
    return this.svc.reviseMeasure(u, id, dto);
  }

  @Post('measures/:id/confirm-alternative')
  confirmAlternative(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConfirmAlternativeDto,
  ) {
    return this.svc.confirmAlternative(u, id, dto);
  }

  @Get('measures/:id/versions')
  versions(@Param('id') id: string) {
    return this.svc.listVersions(id);
  }

  // ---- 重新评估 / 冲突 ----
  @Get('reassessments')
  reassessments(@Query('status') status?: string) {
    return this.svc.listReassessments(status);
  }

  @Post('reassessments/:id/resolve')
  resolveReassessment(@Param('id') id: string) {
    return this.svc.resolveReassessment(id);
  }

  @Get('conflicts')
  conflicts(@Query('activityId') activityId?: string) {
    return this.svc.listConflicts(activityId);
  }

  @Post('conflicts/:id/resolve')
  resolveConflict(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResolveConflictDto,
  ) {
    return this.svc.resolveConflict(u, id, dto.note);
  }

  // ---- 活动准备 ----
  @Post('activities/:id/prepare')
  prepare(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.prepareActivity(u, id);
  }
}
