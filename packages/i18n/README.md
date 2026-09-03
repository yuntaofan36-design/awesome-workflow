# `@awesome-workflow/i18n`

Shared locale mechanics for platform surfaces. Application-specific message
catalogs stay with each application so a Federation remote, iframe, desktop
WebView, and CLI do not depend on one global translation singleton.

## Supported locales

- `en-US` — canonical fallback
- `zh-CN`
- `system` — a persisted preference resolved to one of the locales above

The package normalizes browser and OS language tags, creates a locale snapshot,
updates document language metadata, formats dates/numbers/bytes, and resolves
publisher-authored `localizations`. It does not translate stable protocol data.

## Adding a locale

1. Add the BCP 47 tag to `SupportedLocaleSchema` in `packages/contracts`.
2. Add it to `SUPPORTED_LOCALES`, normalization, fallback, and tests here.
3. Add a complete catalog and key-parity test to every UI and CLI surface.
4. Add the matching Arco locale where available, API problem/email resources,
   OIDC `ui_locales` coverage, and Desktop Agent/SDK allowlists.
5. Regenerate Manifest JSON Schema, OpenAPI, and the API client, then run the
   TypeScript and Rust repository checks.

Do not translate error codes, enum values, JSON property names, Manifest or RPC
fields, signature inputs, audit action identifiers, or structured CLI output.
