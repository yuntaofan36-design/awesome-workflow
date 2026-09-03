import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

import type { PlatformConfig } from '@awesome-workflow/config';
import type { SupportedLocale } from '@awesome-workflow/contracts';

import { loginEmailContent } from '../../i18n/locale.js';
import type { EmailDeliveryPort } from './auth.port.js';

@Injectable()
export class NoopEmailDelivery implements EmailDeliveryPort {
  async sendLoginCode(_input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    locale: SupportedLocale;
  }): Promise<void> {
    // Local/test runs may opt into returning the code from the challenge endpoint.
    // The code is intentionally never written to logs.
  }
}

type MailTransport = Pick<Transporter, 'close' | 'sendMail'>;

@Injectable()
export class SmtpEmailDelivery implements EmailDeliveryPort, OnModuleDestroy {
  private readonly transport: MailTransport;

  constructor(
    private readonly config: PlatformConfig,
    transport?: MailTransport,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: config.SMTP_HOST!,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        requireTLS: config.SMTP_REQUIRE_TLS,
        ...(config.SMTP_USER && config.SMTP_PASSWORD
          ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
          : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        tls: {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
        },
      });
  }

  async sendLoginCode(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    locale: SupportedLocale;
  }): Promise<void> {
    const content = loginEmailContent(input.locale, input.code, input.expiresInMinutes);
    await this.transport.sendMail({
      from: this.config.SMTP_FROM!,
      to: input.email,
      subject: content.subject,
      text: content.text,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}

export class WebhookEmailDelivery implements EmailDeliveryPort {
  constructor(private readonly config: PlatformConfig) {}

  async sendLoginCode(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    locale: SupportedLocale;
  }): Promise<void> {
    const response = await fetch(this.config.EMAIL_WEBHOOK_URL!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.EMAIL_WEBHOOK_TOKEN!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        template: 'login-code',
        locale: input.locale,
        to: input.email,
        variables: { code: input.code, expiresInMinutes: input.expiresInMinutes },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Email delivery failed with status ${response.status}`);
  }
}
