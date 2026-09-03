# Awesome Workflow V2

Awesome Workflow V2 is a secure control plane and two runtime planes for Web
and desktop micro-applications. It replaces the legacy identity chain and
mutable deployment model with standard OIDC, immutable releases, signed
artifacts, atomic channels, capability brokers, and auditable execution.

> This repository is a new implementation. It intentionally does not import
> legacy packages, data, credentials, Portal/Kani/ZTI integration, or P4
> coupling.

## Repository layout

```text
apps/
  api                 Hybrid authentication BFF and modular control-plane API
  worker              artifact validation and publication jobs
  web-shell           Web micro-frontend host
  control-plane       first trusted Federation remote
  desktop             Tauri 2 management UI
  cli                 aw developer and CI client
packages/
  contracts           transport and domain contracts
  i18n                shared locale resolution, persistence and formatting
  manifest-schema     versioned manifest schema and JSON Schema
  web-sdk             capability-limited Web host bridge
  desktop-sdk         task-scoped desktop application SDK
  ui                   shared presentational primitives only
crates/
  agent               user-level scheduler, installer, updater and state
  runner              per-task process boundary
  elevated-helper     one-shot, allowlisted privileged operations
infra/
  compose             local PostgreSQL, Redis, MinIO, Mailpit and Logto
  helm                production stateless components
```

## Local quick start

Prerequisites are Node.js 24, pnpm 10, Rust stable, Docker, and the platform
requirements for Tauri 2.

1. Copy `.env.example` to `.env` and replace every `change-me` value.
2. Start dependencies with `docker compose --env-file .env -f infra/compose/docker-compose.yml up -d postgres redis minio minio-bootstrap mailpit logto`.
3. Run `pnpm install`, `pnpm typecheck`, and `pnpm test`.
4. Start the API and Web surfaces with `pnpm dev:api`, `pnpm dev:web`, and
   `pnpm dev:control-plane`.
5. Start the desktop UI and user Agent with `pnpm dev:desktop` after installing
   Tauri prerequisites.

Mailpit is a local SMTP fixture only. Production uses BFF-owned email OTP over
TLS-protected SMTP plus Logto OIDC for explicitly enabled social Connectors,
with HTTPS and managed secrets throughout.

Administrator account/password login is enabled whenever
`AUTH_PASSWORD_ADMIN_EMAIL` and `AUTH_PASSWORD_ADMIN_PASSWORD` are both set.
The account receives the platform administrator role and signs in through the
same HttpOnly BFF session as the other Web authentication methods. Keep both
values in an untracked `.env` or deployment Secret; omitting both disables the
Provider.

## Internationalization

The platform ships complete `en-US` and `zh-CN` catalogs. Web Shell, Control
Plane, demo Web app, and Tauri UI support an explicit language or `system`,
persist the preference locally, update Arco Design and `document.lang`, and
format dates, numbers, and byte sizes with the resolved locale. Chinese system
variants use the current `zh-CN` catalog until a separately translated
Traditional Chinese catalog is added.

API clients send `Accept-Language`; RFC Problem Details and login email are
localized while their `code`, validation paths, and parameters remain stable.
Publisher-authored application metadata uses `defaultLocale` plus optional
`localizations`. Web micro-apps receive `locale.getCurrent()` and
`locale.changed` through the capability-limited Host SDK.

The desktop UI synchronizes its resolved locale to the persistent user Agent.
Each new task freezes that snapshot in SQLite and passes it to Web UI, Python,
and native applets as task context (`AW_LOCALE` and `AW_FALLBACK_LOCALES` for
processes). Changing the UI language never changes a task already running.
Protocol enums, Manifest keys, signature inputs, audit actions, and CLI JSON
remain locale-independent.

## Frontend bundle boundaries

Web Shell separates session probing, login, the authenticated shell, routed
pages, and each micro-frontend runtime. Desktop follows the same pattern and
loads Tauri dialog/updater capabilities only when invoked. Control Plane keeps
its Federation bootstrap small, then loads its UI, routes, and registration
modal independently. Arco styles are imported by the branch that uses them
rather than through the full distribution stylesheet.

`pnpm build` generates Vite manifests and enforces both synchronous-entry and
maximum-asset budgets. `pnpm check:bundles` first rebuilds the three frontends,
so it cannot pass by reading stale output; `pnpm report:bundles` only inspects
the existing output. The budget also verifies that login/shell,
desktop capability, Federation runtime, and Control Plane route boundaries do
not drift back into their parent entry.

## Core invariants

- A release is immutable. Publish and rollback only move `dev`, `canary`, or
  `stable` channel pointers in a transaction.
- Federation code has host privileges and therefore requires trusted review.
  Untrusted or cross-framework apps run on a distinct origin in a sandboxed
  iframe.
- No micro-app receives a platform session, access token, refresh token, CI
  identity, or signing key.
- Desktop RPC is rejected unless protocol version, app, task, lease, caller,
  and capability all match.
- Native executables are not made safe merely by Tauri. They are allowed only
  for trusted, signed releases and still run with the current OS user rights.
- Production secrets and signing material are injected by Secret Manager/KMS
  or CI workload identity and never committed.

See [architecture](docs/architecture.md), [release model](docs/release-model.md),
[desktop security](docs/desktop-security.md), and [implementation status](docs/implementation-status.md).
