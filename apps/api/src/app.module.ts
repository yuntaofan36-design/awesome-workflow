import { Controller, DynamicModule, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { createClient } from 'redis';

import { CONFIG, loadPlatformConfig, type PlatformConfig } from '@awesome-workflow/config';

import { MemoryPlatformRepository } from './adapters/memory.repository.js';
import { PostgresPlatformRepository } from './adapters/postgres.repository.js';
import { PLATFORM_REPOSITORY } from './core/repository.js';
import { createDatabase } from './db/database.js';
import { ProblemDetailsFilter } from './http/problem-details.filter.js';
import { Public } from './http/public.decorator.js';
import { SessionGuard } from './http/session.guard.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AUTH_RATE_LIMITER, EMAIL_DELIVERY, OIDC_AUTHORITY } from './modules/auth/auth.port.js';
import { AuthService } from './modules/auth/auth.service.js';
import { NoopEmailDelivery, SmtpEmailDelivery, WebhookEmailDelivery } from './modules/auth/email.adapters.js';
import { LogtoOidcAdapter } from './modules/auth/logto.adapter.js';
import {
  MemoryAuthRateLimitAdapter,
  RedisAuthRateLimitAdapter,
  type RedisEvalClient,
} from './modules/auth/rate-limit.adapters.js';
import { ControlPlaneController } from './modules/control-plane/control-plane.controller.js';
import { ControlPlaneService } from './modules/control-plane/control-plane.service.js';
import manifestSchema from './manifest.generated.json' with { type: 'json' };
import openApiDocument from './openapi.generated.json' with { type: 'json' };
import { MemoryObjectStorageAdapter, OBJECT_STORAGE } from './modules/control-plane/object-storage.port.js';
import { S3ObjectStorageAdapter } from './modules/control-plane/s3-object-storage.adapter.js';
import {
  BullMqValidationQueueAdapter,
  MemoryValidationQueueAdapter,
  VALIDATION_QUEUE,
} from './modules/control-plane/validation-queue.port.js';

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { data: { service: 'awesome-workflow-api', status: 'ok' } };
  }

  @Public()
  @Get('openapi.json')
  openApi() {
    return openApiDocument;
  }

  @Public()
  @Get('manifest/awesome-workflow-manifest.schema.json')
  manifestSchema() {
    return manifestSchema;
  }
}

@Module({})
export class AppModule {
  static register(config: PlatformConfig = loadPlatformConfig()): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, ControlPlaneController, HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: PLATFORM_REPOSITORY,
          inject: [CONFIG],
          useFactory: (activeConfig: PlatformConfig) => {
            if (activeConfig.REPOSITORY_MODE === 'memory') return new MemoryPlatformRepository();
            const connection = createDatabase(activeConfig);
            return new PostgresPlatformRepository(connection.database, connection.client);
          },
        },
        { provide: OIDC_AUTHORITY, useClass: LogtoOidcAdapter },
        {
          provide: EMAIL_DELIVERY,
          inject: [CONFIG],
          useFactory: (activeConfig: PlatformConfig) => {
            if (activeConfig.EMAIL_DELIVERY === 'smtp') return new SmtpEmailDelivery(activeConfig);
            if (activeConfig.EMAIL_DELIVERY === 'webhook') return new WebhookEmailDelivery(activeConfig);
            return new NoopEmailDelivery();
          },
        },
        {
          provide: AUTH_RATE_LIMITER,
          inject: [CONFIG],
          useFactory: async (activeConfig: PlatformConfig) => {
            if (activeConfig.NODE_ENV !== 'production') return new MemoryAuthRateLimitAdapter();
            const client = createClient({ url: activeConfig.REDIS_URL! });
            await client.connect();
            return new RedisAuthRateLimitAdapter(client as unknown as RedisEvalClient);
          },
        },
        {
          provide: OBJECT_STORAGE,
          inject: [CONFIG],
          useFactory: (activeConfig: PlatformConfig) =>
            activeConfig.OBJECT_STORAGE_MODE === 's3'
              ? new S3ObjectStorageAdapter(activeConfig)
              : new MemoryObjectStorageAdapter(activeConfig),
        },
        {
          provide: VALIDATION_QUEUE,
          inject: [CONFIG],
          useFactory: (activeConfig: PlatformConfig) =>
            activeConfig.VALIDATION_QUEUE_MODE === 'redis'
              ? new BullMqValidationQueueAdapter(activeConfig.REDIS_URL!)
              : new MemoryValidationQueueAdapter(),
        },
        AuthService,
        ControlPlaneService,
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
