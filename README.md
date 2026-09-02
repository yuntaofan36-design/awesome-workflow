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
