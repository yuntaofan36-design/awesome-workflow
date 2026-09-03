import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ProblemDetails } from '@awesome-workflow/contracts';

import { DomainError } from '../core/errors.js';
import { negotiateLocale, problemDetail, problemTitle, setLanguageHeaders } from '../i18n/locale.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const locale = negotiateLocale(request.headers['accept-language']);
    const normalized = normalize(error);
    const problem: ProblemDetails = {
      type: `https://awesome-workflow.dev/problems/${normalized.code}`,
      title: problemTitle(locale, normalized.status),
      status: normalized.status,
      detail: problemDetail(locale, normalized.code, normalized.detail, normalized.status),
      instance: request.url,
      code: normalized.code,
      ...(normalized.errors === undefined ? {} : { errors: normalized.errors }),
    };
    setLanguageHeaders(response, locale);
    response.header('content-type', 'application/problem+json').status(normalized.status).send(problem);
  }
}

function normalize(error: unknown): {
  status: number;
  code: string;
  detail?: string;
  errors?: unknown;
} {
  if (error instanceof DomainError)
    return {
      status: error.status,
      code: error.code,
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
        detail: Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? error.message),
        errors: body.errors,
      };
    }
    return { status, code: 'http_error', detail: String(response) };
  }
  return {
    status: 500,
    code: 'internal_error',
    detail: 'The server could not complete the request',
  };
}
