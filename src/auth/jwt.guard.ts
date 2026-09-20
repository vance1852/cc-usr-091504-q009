import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../common/domain';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(header.slice(7));
      req.user = {
        id: payload.id,
        role: payload.role,
        linkedStudentId: payload.linkedStudentId ?? null,
        email: payload.email,
        name: payload.name,
      } satisfies AuthUser;
    } catch {
      throw new UnauthorizedException('invalid token');
    }
    return true;
  }
}
