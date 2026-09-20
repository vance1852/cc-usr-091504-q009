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
import { IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../common/enums';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccessModule } from '../access/access.controller';
import { BriefingsService } from './briefings.service';

class ExecuteDto {
  @IsString()
  measureId!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

@UseGuards(AuthGuard)
@Controller('sessions')
export class BriefingsController {
  constructor(private readonly briefings: BriefingsService) {}

  /** 导师当场简报：仅当场必须执行的措施 */
  @Get(':id/briefing')
  briefing(@Param('id') sessionId: string, @CurrentUser() user: AuthUser) {
    return this.briefings.instructorBriefing(user, sessionId);
  }

  /** 协调员活动准备结果 */
  @Roles(Role.COORDINATOR)
  @Get(':id/preparation')
  preparation(@Param('id') sessionId: string, @CurrentUser() user: AuthUser) {
    return this.briefings.preparation(user, sessionId);
  }

  /** 导师阅读回执 */
  @Roles(Role.INSTRUCTOR)
  @Post(':id/acknowledge')
  acknowledge(@Param('id') sessionId: string, @CurrentUser() user: AuthUser) {
    return this.briefings.acknowledge(user, sessionId);
  }

  /** 导师登记措施已执行（写入不可变快照） */
  @Roles(Role.INSTRUCTOR)
  @Post(':id/executions')
  execute(
    @Param('id') sessionId: string,
    @Body() dto: ExecuteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.briefings.logExecution(user, sessionId, dto.measureId, dto.note);
  }

  /** 执行记录：协调员可见全场；导师仅限本人场次；家长走 /guardian 视图 */
  @Get(':id/executions')
  executions(
    @Param('id') sessionId: string,
    @CurrentUser() user: AuthUser,
    @Query('studentId') studentId?: string,
  ) {
    if (user.role === Role.GUARDIAN || user.role === Role.STUDENT) {
      throw new ForbiddenException('家长请使用 /guardian 视图查看本人孩子记录');
    }
    return this.briefings.listExecutions(sessionId, user, studentId);
  }
}

@Module({
  imports: [JwtModule.register({}), AccessModule],
  providers: [BriefingsService],
  controllers: [BriefingsController],
  exports: [BriefingsService],
})
export class BriefingsModule {}
