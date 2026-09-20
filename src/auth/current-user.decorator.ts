import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../common/domain';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
