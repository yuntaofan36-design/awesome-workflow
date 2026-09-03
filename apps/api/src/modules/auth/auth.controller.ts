import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  CliAuthorizationInputSchema,
  CliRefreshTokenInputSchema,
  CliTokenInputSchema,
  OidcAuthorizationInputSchema,
  PasswordLoginInputSchema,
  StartEmailChallengeInputSchema,
  VerifyEmailChallengeInputSchema,
  WorkloadTokenExchangeInputSchema,
  type CurrentUser,
} from '@awesome-workflow/contracts';
import { CONFIG, type PlatformConfig } from '@awesome-workflow/config';
import { Inject } from '@nestjs/common';
import { z } from 'zod';

import { Actor } from '../../http/actor.decorator.js';
import { Public } from '../../http/public.decorator.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import { bearerToken, cookieToken } from '../../http/session.guard.js';
import { AuthService } from './auth.service.js';
import { negotiateLocale } from '../../i18n/locale.js';

const OidcCallbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
const CliApprovalQuerySchema = z.object({ requestId: z.string().uuid() });
const CliTokenRequestSchema = z.union([CliTokenInputSchema, CliRefreshTokenInputSchema]);
const SESSION_COOKIE = 'aw_session';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: PlatformConfig,
  ) {}

  @Public()
  @Get('providers')
  providers() {
    return { data: this.auth.providers() };
  }

  @Public()
  @Post('password/login')
  @HttpCode(200)
  async loginPassword(
    @Body(new ZodPipe(PasswordLoginInputSchema)) input: z.infer<typeof PasswordLoginInputSchema>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.loginPassword(input.email, input.password, request.ip);
    this.writeSessionCookie(reply, session.accessToken, session.expiresAt);
    return { data: session.user };
  }

  @Public()
  @Post('email/challenges')
  @HttpCode(200)
  async requestEmailCode(
    @Body(new ZodPipe(StartEmailChallengeInputSchema)) input: z.infer<typeof StartEmailChallengeInputSchema>,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.auth.requestEmailCode(
        input.email,
        request.ip,
        negotiateLocale(request.headers['accept-language']),
      ),
    };
  }

  @Public()
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmailCode(
    @Body(new ZodPipe(VerifyEmailChallengeInputSchema))
    input: z.infer<typeof VerifyEmailChallengeInputSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.verifyEmailCode(input.challengeId, input.code);
    this.writeSessionCookie(reply, session.accessToken, session.expiresAt);
    return { data: session.user };
  }

  @Public()
  @Get('oidc/start')
  async beginOidc(
    @Query(new ZodPipe(OidcAuthorizationInputSchema)) input: z.infer<typeof OidcAuthorizationInputSchema>,
    @Req() request: FastifyRequest,
  ) {
    return {
      data: await this.auth.beginOidc({
        ...input,
        uiLocales: input.uiLocales ?? negotiateLocale(request.headers['accept-language']),
      }),
    };
  }

  @Public()
  @Get('oidc/callback')
  async completeOidc(
    @Query(new ZodPipe(OidcCallbackSchema)) input: z.infer<typeof OidcCallbackSchema>,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.auth.completeOidc(input);
    this.writeSessionCookie(reply, result.session.accessToken, result.session.expiresAt);
    return reply.redirect(result.returnTo ?? this.config.OIDC_POST_LOGIN_REDIRECT ?? '/');
  }

  @Public()
  @Post('cli/authorize')
  @HttpCode(200)
  async beginCliAuthorization(
    @Body(new ZodPipe(CliAuthorizationInputSchema)) input: z.infer<typeof CliAuthorizationInputSchema>,
    @Req() request: FastifyRequest,
  ) {
    return { data: await this.auth.beginCliAuthorization(input, request.ip) };
  }

  @Get('cli/approve')
  async approveCliAuthorization(
    @Query(new ZodPipe(CliApprovalQuerySchema)) input: z.infer<typeof CliApprovalQuerySchema>,
    @Actor() actor: CurrentUser,
    @Res() reply: FastifyReply,
  ) {
    return reply.status(302).redirect(await this.auth.approveCliAuthorization(input.requestId, actor));
  }

  @Public()
  @Post('cli/token')
  @HttpCode(200)
  async exchangeCliToken(
    @Body(new ZodPipe(CliTokenRequestSchema)) input: z.infer<typeof CliTokenRequestSchema>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    if ('grant_type' in input) return this.auth.refreshCliToken(input, request.ip);
    return { data: await this.auth.exchangeCliCode(input, request.ip) };
  }

  @Public()
  @Post('workload/exchange')
  @HttpCode(200)
  async exchangeWorkloadToken(
    @Body(new ZodPipe(WorkloadTokenExchangeInputSchema))
    input: z.infer<typeof WorkloadTokenExchangeInputSchema>,
    @Req() request: FastifyRequest,
  ) {
    return { data: await this.auth.exchangeWorkloadToken(input, request.ip) };
  }

  @Get('session')
  session(@Actor() actor: CurrentUser) {
    return { data: actor };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(bearerToken(request.headers.authorization) ?? cookieToken(request.headers.cookie));
    reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
  }

  private writeSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      path: '/api/v1',
      sameSite: 'lax',
      secure: this.config.NODE_ENV === 'production',
      expires: new Date(expiresAt),
    });
  }
}
