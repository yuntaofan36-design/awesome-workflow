import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ProblemDetails } from '@awesome-workflow/contracts';

import { DomainError } from '../core/errors.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const normalized = normalize(error);
    const problem: ProblemDetails = {
      type: `https://awesome-workflow.dev/problems/${normalized.code}`,
      title: normalized.title,
      status: normalized.status,
      detail: normalized.detail,
      instance: request.url,
      code: normalized.code,
      ...(normalized.errors === undefined ? {} : { errors: normalized.errors }),
    };
    response.header('content-type', 'application/problem+json').status(normalized.status).send(problem);
  }
}

function normalize(error: unknown): {
  status: number;
  code: string;
  title: string;
  detail?: string;
  errors?: unknown;
} {
  if (error instanceof DomainError)
    return {
      status: error.status,
      code: error.code,
      title: titleFor(error.status),
      detail: error.message,
      errors: error.errors,
    };
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    if (response && typeof response === 'object') {
      const body = response as { code?: string; message?: string | string[]; errors?: unknown };
      return {
        status,
        code: body.code ?? 'http_error',
        title: titleFor(status),
        detail: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? error.message),
        errors: body.errors,
      };
    }
    return { status, code: 'http_error', title: titleFor(status), detail: String(response) };
  }
  return {
    status: 500,
    code: 'internal_error',
    title: 'Internal Server Error',
    detail: 'The server could not complete the request',
  };
}

const titleFor = (status: number) =>
  status === 400
    ? 'Bad Request'
    : status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 409
            ? 'Conflict'
            : status === 429
              ? 'Too Many Requests'
              : status >= 500
                ? 'Internal Server Error'
                : 'Request Failed';
