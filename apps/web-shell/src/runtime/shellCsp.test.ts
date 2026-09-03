import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createShellCsp, VITE_REACT_REFRESH_PREAMBLE_HASH } from './shellCsp';

const VITE_REACT_REFRESH_PREAMBLE = `import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;`;

const baseInput = {
  apiOrigins: [] as string[],
  frameOrigins: [] as string[],
  trustedFederationOrigins: ['https://cdn.example.test'],
  webPort: 4300,
};

describe('Shell Content-Security-Policy', () => {
  it('allows only the exact Vite React Refresh preamble hash in development', () => {
    const expectedHash = `'sha256-${createHash('sha256')
      .update(VITE_REACT_REFRESH_PREAMBLE)
      .digest('base64')}'`;
    const csp = createShellCsp({ ...baseInput, allowViteReactRefresh: true });
    const scriptDirective = directive(csp, 'script-src');

    expect(VITE_REACT_REFRESH_PREAMBLE_HASH).toBe(expectedHash);
    expect(scriptDirective).toContain(VITE_REACT_REFRESH_PREAMBLE_HASH);
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
  });

  it('does not allow the development preamble in production', () => {
    const csp = createShellCsp({ ...baseInput, allowViteReactRefresh: false });
    const scriptDirective = directive(csp, 'script-src');

    expect(scriptDirective).not.toContain(VITE_REACT_REFRESH_PREAMBLE_HASH);
    expect(scriptDirective).toBe("script-src 'self' https://cdn.example.test");
  });
});

function directive(csp: string, name: string): string {
  const value = csp.split('; ').find((candidate) => candidate.startsWith(`${name} `));
  if (!value) throw new Error(`Missing ${name} directive`);
  return value;
}
