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
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SessionsService } from './sessions.service';

class CreateSessionDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsString()
  startAt!: string;

  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @IsString()
  instructorId!: string;
}

class ChangeContentDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  startAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

class EnrollDto {
  @IsString()
  studentId!: string;
}

class InfeasibleDto {
  @IsString()
  studentId!: string;

  @IsOptional()
  @IsString()
  measureId?: string;

  @IsString()
  description!: string;
}

class ResolveDto {
  @IsString()
  note!: string;
}

@UseGuards(AuthGuard)
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Roles(Role.COORDINATOR)
  @Post()
  create(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user, dto);
  }

  @Get()
  list(@Query('upcoming') upcoming?: string) {
    return this.sessions.list(upcoming === 'true');
  }

  @Get(':id')
  get(@Param('id') sessionId: string) {
    return this.sessions.get(sessionId);
  }

  @Roles(Role.COORDINATOR)
  @Post(':id/enrollments')
  enroll(
    @Param('id') sessionId: string,
    @Body() dto: EnrollDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.enroll(sessionId, dto.studentId, user.id);
  }

  /**
   * 活动内容改变：自动为报名学生生成重评标记，并检测多活动时间重叠。
   */
  @Roles(Role.COORDINATOR)
  @Post(':id/content-change')
  changeContent(
    @Param('id') sessionId: string,
    @Body() dto: ChangeContentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.changeContent(user, sessionId, dto, dto.note);
  }

  @Roles(Role.INSTRUCTOR, Role.COORDINATOR)
  @Post(':id/conflicts/infeasible')
  reportInfeasible(
    @Param('id') sessionId: string,
    @Body() dto: InfeasibleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.reportInfeasible(
      user,
      sessionId,
      dto.studentId,
      dto.measureId ?? null,
      dto.description,
    );
  }

  @Roles(Role.COORDINATOR)
  @Post('conflicts/:cid/resolve')
  resolveConflict(
    @Param('cid') conflictId: string,
    @Body() dto: ResolveDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.resolveConflict(user, conflictId, dto.note);
  }

  @Roles(Role.COORDINATOR)
  @Post('reassessment-flags/:fid/resolve')
  resolveFlag(
    @Param('fid') flagId: string,
    @Body() dto: ResolveDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.resolveFlag(user, flagId, dto.note);
  }

  @Get(':id/reassessment-flags')
  listFlags(
    @Param('id') sessionId: string,
    @Query('studentId') studentId?: string,
  ) {
    return this.sessions.openFlags(sessionId, studentId);
  }

  @Get(':id/conflicts')
  listConflicts(@Param('id') sessionId: string) {
    return this.sessions.openConflicts(sessionId);
  }
}

@Module({
  imports: [JwtModule.register({})],
  providers: [SessionsService],
  controllers: [SessionsController],
  exports: [SessionsService],
})
export class SessionsModule {}
