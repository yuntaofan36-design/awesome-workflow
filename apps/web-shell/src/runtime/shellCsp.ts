export const VITE_REACT_REFRESH_PREAMBLE_HASH = "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

export function createShellCsp(input: {
  allowViteReactRefresh: boolean;
  apiOrigins: readonly string[];
  frameOrigins: readonly string[];
  trustedFederationOrigins: readonly string[];
  webPort: number;
}): string {
  const federation = input.trustedFederationOrigins.join(' ');
  const connect = [...input.trustedFederationOrigins, ...input.apiOrigins].join(' ');
  const frames = input.frameOrigins.length > 0 ? input.frameOrigins.join(' ') : "'none'";
  const inlineScriptHashes = input.allowViteReactRefresh ? VITE_REACT_REFRESH_PREAMBLE_HASH : '';
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `script-src 'self' ${inlineScriptHashes} ${federation}`.replace(/\s+/g, ' ').trim(),
    `style-src 'self' 'unsafe-inline' ${federation}`.trim(),
    `img-src 'self' data: blob: ${federation}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' ${connect} ws://localhost:${input.webPort} ws://127.0.0.1:${input.webPort}`.trim(),
    `frame-src ${frames}`,
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
