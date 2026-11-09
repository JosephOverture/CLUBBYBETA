import { Catch, HttpException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class ApiError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status = 400,
  ) {
    super(message, status);
  }
}
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const fastifyStatus =
      exception && typeof exception === 'object' && 'statusCode' in exception
        ? Number(exception.statusCode)
        : 0;
    const pgCode =
      exception && typeof exception === 'object' && 'code' in exception ? String(exception.code) : '';
    const status =
      exception instanceof ZodError
        ? 400
        : exception instanceof HttpException
          ? exception.getStatus()
          : pgCode === '23505'
            ? 409
            : pgCode === '23503'
              ? 400
              : [400, 413, 415, 429].includes(fastifyStatus)
                ? fastifyStatus
                : 500;
    const code =
      exception instanceof ApiError
        ? exception.code
        : exception instanceof ZodError
          ? 'INVALID_REQUEST'
          : status === 404
            ? 'NOT_FOUND'
            : status >= 500
              ? 'INTERNAL_ERROR'
              : 'REQUEST_FAILED';
    const message =
      exception instanceof ApiError
        ? exception.message
        : status === 404
          ? 'Resource not found.'
          : status >= 500
            ? 'Unable to complete request.'
            : 'Invalid request.';
    if (status >= 500) request.log.error({ code, requestId: request.id }, 'Request failed');
    void reply.status(status).send({ error: { code, message, requestId: request.id } });
  }
}
