import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success)
      throw new BadRequestException({
        code: 'validation_failed',
        message: 'Request validation failed',
        errors: result.error.issues.map(({ code, message: _message, path, ...params }) => ({
          code,
          path,
          ...(Object.keys(params).length ? { params } : {}),
        })),
      });
    return result.data;
  }
}
