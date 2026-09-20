import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { MentorService } from './mentor.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../common/domain';

class ExecuteDto {
  @IsOptional()
  @IsString()
  note?: string;
}

@Roles('mentor')
@Controller('mentor')
export class MentorController {
  constructor(private readonly svc: MentorService) {}

  @Get('briefings')
  list(@CurrentUser() u: AuthUser, @Query('activityId') activityId?: string) {
    return this.svc.listBriefings(u, activityId);
  }

  @Post('briefings/:id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.markRead(u, id);
  }

  @Post('briefings/:id/execute')
  execute(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ExecuteDto,
  ) {
    return this.svc.execute(u, id, dto.note);
  }

  @Get('executions')
  executions(@CurrentUser() u: AuthUser) {
    return this.svc.listMyExecutions(u);
  }
}
