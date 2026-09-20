import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { GuardianService } from './guardian.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../common/domain';

class GrantConsentDto {
  @IsString()
  scope!: string;

  @IsOptional()
  @IsString()
  details?: string;
}

class RevokeConsentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

@Roles('guardian')
@Controller('guardian')
export class GuardianController {
  constructor(private readonly svc: GuardianService) {}

  @Get('child/current')
  current(@CurrentUser() u: AuthUser) {
    return this.svc.currentView(u);
  }

  @Get('consents')
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listConsents(u);
  }

  @Post('consents')
  grant(@CurrentUser() u: AuthUser, @Body() dto: GrantConsentDto) {
    return this.svc.grantConsent(u, dto);
  }

  @Post('consents/:id/revoke')
  revoke(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: RevokeConsentDto,
  ) {
    return this.svc.withdrawConsent(u, id, dto.note);
  }
}
