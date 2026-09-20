import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../common/enums';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少登录凭证');
    }
    try {
      req.user = this.jwt.verify(header.slice(7), {
        secret: process.env.JWT_SECRET || 'dev-secret',
      });
    } catch {
      throw new UnauthorizedException('登录凭证无效或已过期');
    }

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && !required.includes(req.user.role)) {
      throw new ForbiddenException('角色无权执行该操作');
    }
    return true;
  }
}
