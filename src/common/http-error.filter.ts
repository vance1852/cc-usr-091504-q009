import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(
        typeof body === 'string'
          ? { error: body }
          : body,
      );
      return;
    }
    // node:sqlite 外键/约束错误等不泄露内部细节
    const message =
      exception instanceof Error ? exception.message : 'internal error';
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: message });
  }
}
