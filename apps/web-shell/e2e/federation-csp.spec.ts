import { expect, test, type APIRequestContext } from '@playwright/test';

const shellUrl =
  'http://127.0.0.1:4390/csp-harness.html' + '?allowed=http://127.0.0.1:4391&blocked=http://127.0.0.1:4392';

test('loads the approved Federation graph and browser-blocks an unapproved origin', async ({
  page,
  request,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const shellResponse = await page.goto(shellUrl, { waitUntil: 'networkidle' });
  expect(shellResponse?.ok(), 'CSP harness did not load').toBe(true);

  const csp = shellResponse?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain('http://127.0.0.1:4391');
  expect(csp).not.toContain('http://127.0.0.1:4392');

  await expect(page.locator('body')).toHaveAttribute('data-status', 'passed');
  await expect(page.locator('body')).toHaveAttribute('data-allowed-remote', 'passed');
  await expect(page.locator('body')).toHaveAttribute('data-runtime-block', 'passed');
  await expect(page.locator('body')).toHaveAttribute('data-csp-block', 'passed');
  expect(await page.evaluate(() => globalThis.__blockedFederationScriptExecuted === true)).toBe(false);
  expect(
    consoleErrors.some(
      (message) => message.includes('Content Security Policy') || message.includes('violates'),
    ),
    `expected a browser CSP console error, received: ${JSON.stringify(consoleErrors)}`,
  ).toBe(true);

  const allowedHits = await readHits(request, 4391);
  const blockedHits = await readHits(request, 4392);
  expect(allowedHits.some((path) => path.endsWith('/mf-manifest.json'))).toBe(true);
  expect(allowedHits.some((path) => path.endsWith('/remoteEntry.js'))).toBe(true);
  expect(allowedHits.some((path) => path.includes('/assets/') && path.endsWith('.js'))).toBe(true);
  expect(allowedHits.some((path) => path.endsWith('.css'))).toBe(true);
  expect(blockedHits).not.toContain('/probe.js');
});

async function readHits(request: APIRequestContext, port: number): Promise<string[]> {
  const response = await request.get(`http://127.0.0.1:${port}/__hits`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as string[];
}

declare global {
  var __blockedFederationScriptExecuted: boolean | undefined;
}
