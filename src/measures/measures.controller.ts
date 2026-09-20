import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role, ALL_MEASURE_TYPES, AlternativeStatus } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccessModule } from '../access/access.controller';
import { AccessPolicyService } from '../access/access-policy.service';
import { MeasuresService } from './measures.service';
import { AlternativesService } from './alternatives.service';

class CreateMeasureDto {
  @IsString()
  studentId!: string;

  @IsIn(ALL_MEASURE_TYPES)
  type!: string;

  @IsString()
  instruction!: string;

  /** YYYY-MM-DD */
  @IsString()
  reviewDate!: string;

  @IsIn(['ALL', 'SESSIONS'])
  target!: 'ALL' | 'SESSIONS';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sessionIds?: string[];

  @IsIn(['ALL_INSTRUCTORS', 'INSTRUCTORS'])
  visibility!: 'ALL_INSTRUCTORS' | 'INSTRUCTORS';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  instructorIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceMaterialIds?: string[];
}

class NewVersionDto extends CreateMeasureDto {}

class ProposeAlternativeDto {
  @IsIn(ALL_MEASURE_TYPES)
  type!: string;

  @IsString()
  instruction!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class ReviewAlternativeDto {
  @IsIn([AlternativeStatus.CONFIRMED, AlternativeStatus.REJECTED])
  status!: AlternativeStatus.CONFIRMED | AlternativeStatus.REJECTED;

  @IsOptional()
  @IsString()
  note?: string;
}

@UseGuards(AuthGuard)
@Controller()
export class MeasuresController {
  constructor(
    private readonly measures: MeasuresService,
    private readonly alternatives: AlternativesService,
    private readonly policy: AccessPolicyService,
  ) {}

  @Roles(Role.COORDINATOR)
  @Post('measures')
  create(@Body() dto: CreateMeasureDto, @CurrentUser() user: AuthUser) {
    return this.measures.create(user, dto.studentId, dto.type as never, {
      instruction: dto.instruction,
      reviewDate: dto.reviewDate,
      target: dto.target,
      sessionIds: dto.sessionIds,
      visibility: dto.visibility,
      instructorIds: dto.instructorIds,
      sourceMaterialIds: dto.sourceMaterialIds,
    });
  }

  @Roles(Role.COORDINATOR)
  @Post('measures/:id/versions')
  newVersion(
    @Param('id') measureId: string,
    @Body() dto: NewVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.measures.newVersion(user, measureId, {
      instruction: dto.instruction,
      reviewDate: dto.reviewDate,
      target: dto.target,
      sessionIds: dto.sessionIds,
      visibility: dto.visibility,
      instructorIds: dto.instructorIds,
      sourceMaterialIds: dto.sourceMaterialIds,
    });
  }

  @Roles(Role.COORDINATOR)
  @Post('measures/:id/retire')
  retire(@Param('id') measureId: string, @CurrentUser() user: AuthUser) {
    return this.measures.retire(user, measureId);
  }

  /**
   * 措施列表：协调员可见全部操作化版本；
   * 监护人/学生仅可见本人孩子的版本；导师不通过此接口读取（应读当场简报）。
   */
  @Get('measures')
  list(@Query('studentId') studentId: string, @CurrentUser() user: AuthUser) {
    if (user.role === Role.INSTRUCTOR) {
      return [];
    }
    this.policy.assertFamilyAccess(user.id, user.role, studentId);
    return this.measures.list(studentId);
  }

  @Get('measures/:id')
  detail(@Param('id') measureId: string, @CurrentUser() user: AuthUser) {
    const detail = this.measures.getDetail(measureId);
    if (user.role === Role.INSTRUCTOR) {
      return null;
    }
    this.policy.assertFamilyAccess(user.id, user.role, detail.studentId);
    return detail;
  }

  // ---------- 替代措施 ----------

  @Roles(Role.INSTRUCTOR, Role.COORDINATOR)
  @Post('measures/:id/alternatives')
  propose(
    @Param('id') measureId: string,
    @Body() dto: ProposeAlternativeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.alternatives.propose(user, measureId, dto as never);
  }

  @Roles(Role.COORDINATOR)
  @Post('alternatives/:id/review')
  review(
    @Param('id') altId: string,
    @Body() dto: ReviewAlternativeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.alternatives.review(user, altId, dto.status, dto.note);
  }

  @Get('measures/:id/alternatives')
  listAlternatives(
    @Param('id') measureId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const detail = this.measures.getDetail(measureId);
    if (user.role === Role.INSTRUCTOR) {
      // 导师只能看到自己提出过替代措施的条目：仍允许读状态
      return this.alternatives.listForMeasure(measureId);
    }
    this.policy.assertFamilyAccess(user.id, user.role, detail.studentId);
    return this.alternatives.listForMeasure(measureId);
  }
}

@Module({
  imports: [JwtModule.register({}), AccessModule],
  providers: [MeasuresService, AlternativesService],
  controllers: [MeasuresController],
  exports: [MeasuresService, AlternativesService],
})
export class MeasuresModule {}
