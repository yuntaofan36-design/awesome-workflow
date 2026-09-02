# Legacy `p_workflow` architecture audit

Audited source: `C:\Users\Admin\project\work\p_workflow`,
`release-canary@26dae8ae0e9f82c3926eb1237add2d26be43d9ac`.
This document records architecture evidence only; no legacy credential value is
copied into V2.

## Web plane

```text
request /:app or /:project/:app
  -> Nest StaticService selects app + Appshell version from nav cache
  -> EJS injects API_PREFIX / APPSHELL / NAV_LIST and global dependencies
  -> React 17 Appshell fetches account/navigation/categories/projects
  -> MountPoint resolves ATTACH / IFRAME / LINK
  -> qiankun entry, iframe postMessage bridge, or external navigation
```

Evidence:

- `packages/server/src/modules/static/static.service.ts:64-71` selects the
  application and renders the shell.
- `packages/appshell/index.ejs:25-27` injects globals and versioned global
  React/Antd resources.
- `packages/appshell/src/App.tsx:29-47` refetches user and navigation state.
- `packages/appshell/src/MountPoint.tsx:130-131` registers ATTACH resources;
  IFRAME rendering is at `:263-266` and LINK/IFRAME routing is at `:420-429`.
- `packages/appshell/src/bridges/iframe-bridge.ts:49-105` synchronizes iframe and
  host routing.

The runtime is micro-frontend capable, but the source and dependency graph is
still a large shared `ui` package. The Shell and child apps duplicate account,
project and catalog requests. React 17, Webpack globals, qiankun, multiple Antd
versions and runtime monkey-patching form a tight compatibility matrix.

## Web publication

```text
developer creates App -> long-lived App key/token
  -> jn-mf-tools/Webpack builds one ENTRY at a time
  -> assets upload to object storage/CDN
  -> /open-api/app/create-version registers mutable version metadata
  -> developer selects testVersion/currentVersion
  -> nav cache is rebuilt
  -> Appshell resolves resources for current user
```

Evidence:

- `packages/ui/config/web.deploy.config.js:234-318` performs validation, builds,
  upload and version registration.
- `packages/server/src/modules/app/app.service.ts:64-289` creates applications,
  versions and navigation projections.
- `packages/server/src/modules/open-api/open-api.controller.ts:122-128` exposes the
  deployment OpenAPI.
- `packages/server/src/common/guards/app-token.guard.ts:22-31` authenticates with
  the application key/token pair.

The legacy deployment configuration contains long-lived plaintext deployment
credentials. Their values are not copied into V2 or reproduced in this audit;
they must be rotated independently. Version, artifact, approval and channel do
not share a single immutable state machine, and remote code lacks a signed
catalog/SRI trust elevation step.

## Authentication and authorization

```text
JWA OAuth2 -> Passport OAuth strategy -> Mongo-backed Session cookie
  -> IsLoggedGuard restores Workflow user (or Portal token fallback)
  -> Kani/Protego/ZTI checks workflow/developer/admin capability
  -> some attached apps run hidden-iframe silent login
```

Evidence:

- `packages/server/src/modules/auth/jwa.strategy.ts:12-21` configures the JWA
  OAuth strategy and token exchange.
- `packages/server/src/main.ts:57-77` configures the Mongo session and Passport.
- `packages/server/src/common/guards/is-logged.guard.ts:33-47` includes the Portal
  token-to-session path.
- `packages/server/src/common/guards/kani.guard.ts:19-27` applies proprietary
  authorization.
- `packages/appshell/src/bridges/login-bridge.ts:34-102` implements child-app silent
  login.

Identity, workflow authorization, desktop identity and micro-app session
bridging are coupled. V2 replaces only authentication with OIDC while retaining
authorization as an explicit internal workspace/platform policy model.

## Desktop plane

```text
master Electron process
  -> visible UI renderers + hidden BACKGROUND renderer
  -> scheduler / prepare dependency DAG / downloader / installer / executor
  -> Python or EXE process
  -> local HTTP/WebSocket Bus, IPC string RPC, mirrored Zustand state

Windows service -> periodic workflow.exe --daemon-check wake-up
```

Evidence:

- `packages/ui/src/main/index.ts:39-57` selects command-line/elevated/daemon mode.
- `packages/ui/src/render/entries/background/BackgroundWindowBootstrap.ts:90`
  starts Python, scheduler, executor, polling and local APIs in a hidden
  renderer.
- `packages/ui/src/services/entities/render/SchedulerService.ts:152`
  creates tasks and selects ordinary/elevated executors.
- `packages/ui/src/services/entities/native/stage-executor/PrepareStage.ts:155`
  builds dependencies and download tasks.
- `packages/ui/src/services/entities/native/applet-runner/MicroAppletRunner.ts:44`
  launches Python or native executables.
- `packages/ui-service/src/service/windows/service.rs:82-103` and
  `service/windows/service_exec.rs:219` implement the periodic service wake-up.

The useful product capabilities are local development, packaging, install,
dependency DAG, manual/scheduled/automatic run, logging, custom Web UI, CLI and
protocol launch. The unsafe architectural property is that orchestration and
host authority live in renderers and dynamic string RPC rather than a
capability-checked user Agent.

## Confirmed high-priority defects and boundaries

- `packages/ui/src/services/entities/main/window/BaseWindow.ts:57-60` enables
  Node integration, disables context isolation and enables the remote module;
  renderer XSS can become local code execution.
- `packages/ui/src/services/entities/render/http-api/HttpApiService.ts:106`
  exposes broad CORS and the local execution controller
  lacks a strong task-scoped principal.
- Distribution archives are executed after download without a mandatory
  SHA-256 + publisher signature + safe extraction gate.
- `packages/server/src/modules/auth/auth.controller.ts:43-48` redirects using
  OAuth state without a visible
  same-origin/allowlist validation.
- `packages/appshell/src/bridges/iframe-bridge.ts:75-99` does not require both
  `event.origin` and `event.source`.
- `packages/server/src/modules/app/app.service.ts:64-69` calls an async
  administrator check without `await`.
- Navigation cache is non-expiring while removal paths do not consistently
  rebuild it.
- Electron session cookies, service tokens and other local state cross too many
  processes; some long-lived values are stored in plaintext local files.

These findings explain V2's boundaries: standard OIDC, internal RBAC,
immutable releases, signed artifacts, strict iframe handshake, renderer least
privilege, OS credential storage, a user-level Rust Agent, per-task leases and
one-shot elevation.
