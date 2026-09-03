import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPlatformConfig } from '@awesome-workflow/config';

import { SmtpEmailDelivery } from './email.adapters.js';

test('SMTP delivery sends a fixed text-only login message without URL or file access', async () => {
  const messages: Array<Record<string, unknown>> = [];
  let closed = false;
  const transport = {
    async sendMail(message: Record<string, unknown>) {
      messages.push(message);
      return {};
    },
    close() {
      closed = true;
    },
  };
  const adapter = new SmtpEmailDelivery(
    loadPlatformConfig({
      EMAIL_DELIVERY: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_REQUIRE_TLS: 'true',
      SMTP_FROM: 'Awesome Workflow <no-reply@example.test>',
    }),
    transport as never,
  );

  await adapter.sendLoginCode({
    email: 'person@example.test',
    code: '042913',
    expiresInMinutes: 5,
    locale: 'en-US',
  });
  adapter.onModuleDestroy();

  assert.equal(messages.length, 1);
  assert.deepEqual(
    {
      from: messages[0]?.from,
      to: messages[0]?.to,
      subject: messages[0]?.subject,
      disableFileAccess: messages[0]?.disableFileAccess,
      disableUrlAccess: messages[0]?.disableUrlAccess,
    },
    {
      from: 'Awesome Workflow <no-reply@example.test>',
      to: 'person@example.test',
      subject: 'Your Awesome Workflow sign-in code',
      disableFileAccess: true,
      disableUrlAccess: true,
    },
  );
  assert.match(String(messages[0]?.text), /042913/);
  assert.match(String(messages[0]?.text), /5 minutes/);
  assert.equal(closed, true);
});
