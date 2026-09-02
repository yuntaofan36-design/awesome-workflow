import 'reflect-metadata';

import cookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { loadPlatformConfig, type PlatformConfig } from '@awesome-workflow/config';

import { AppModule } from './app.module.js';

export async function createApiApplication(
  config: PlatformConfig = loadPlatformConfig(),
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config),
    new FastifyAdapter({ trustProxy: false }),
    { abortOnError: false, logger: config.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'] },
  );
  // pnpm may expose two structurally compatible Fastify type identities through
  // Nest and the plugin; the runtime plugin is the same Fastify v5 contract.
  await app.register(cookie as never);
  app.enableCors({ credentials: true, origin: config.origins });
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
