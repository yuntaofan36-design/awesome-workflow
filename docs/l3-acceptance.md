# L3 acceptance

L3 is an environment-backed acceptance layer. Unit tests, Nest injection,
in-memory repositories and a successful compile do not count as L3 evidence.

## Infrastructure and control-plane L3

Run from the repository root with Docker Desktop/Engine available:

```powershell
pnpm test:l3:infra
```

Every run creates random ephemeral credentials, a unique Compose project,
dynamic host ports and new volumes. It deliberately does not read the project
`.env` and does not start or stop the developer stack on ports 4100/4300. The
script then:

1. starts the checked-in PostgreSQL 17, Redis 7.4 and MinIO services and waits
   for their real health checks;
2. creates a private, run-scoped bucket and applies all checked-in Drizzle
   migrations to a fresh PostgreSQL database;
3. verifies required tables and performs an atomic Redis-backed auth rate-limit
   check with independent buckets;
4. performs a browser CORS preflight, presigned S3 `PUT`, `HEAD` declaration
   verification, presigned `GET` and SHA-256 comparison;
5. sends that object and its SPDX SBOM through BullMQ to a host-process Worker
   using the production validation function and an ephemeral Ed25519 key pair;
6. starts the real Nest/Fastify API as a host Node.js process on an ephemeral
   TCP port, checks
   `/api/v1/health`, logs in with a run-scoped administrator and confirms the
   user, session and personal workspace were persisted in PostgreSQL.

The failure path prints at most 120 log lines per dependency, then always runs
`docker compose down --volumes --remove-orphans`. Recursive temp removal is
restricted to an exact `aw-l3-<12 hex>` child of the system temp directory.

This stage proves the backend S3 upload contract. It does not claim that a
published Federation remote is deployable from MinIO; browser remotes use their
reviewed CDN/origin and have a separate Federation/CSP browser gate.

PostgreSQL, Redis and MinIO are real Compose containers. The API and BullMQ
Worker in this gate are real host processes connected to those containers; the
gate does **not** build or start the `api` and `worker` Dockerfile targets, does
not start Logto, and is not container-image acceptance. Starting the complete
application image graph remains an explicit open deployment gate because it
also requires a configured Logto application and trusted release/authorization
signing material.

## Federation CSP browser L3

Run the repository-owned Playwright gate with Chromium installed:

```powershell
pnpm --filter @awesome-workflow/web-shell exec playwright install chromium
pnpm test:l3:web-csp
```

The gate builds the real Control Plane Federation remote, starts independent
Shell, allowed-remote and blocked-origin HTTP processes, and reads the CSP from
the Shell response in Chromium. It proves that the approved
`mf-manifest.json`, `remoteEntry.js`, JavaScript chunks and CSS execute without
`unsafe-eval`; the Shell rejects an origin outside the deployment policy, the
browser emits `securitypolicyviolation`, and the blocked server records no
request for the probe script. Playwright owns and terminates all three servers.

This does not prove the production Nginx/Ingress response, CDN immutability,
HTTPS or cache behavior. Those remain deployment-image and production gates.

## Desktop preflight and real process gate

The portable headless checks are intentionally labelled preflight:

```powershell
pnpm test:l3:desktop-preflight
```

They build the React WebView, compile the Agent/Runner/helper and run Agent IPC,
task-RPC, lease and Tauri host tests. They do not launch a WebView and therefore
must not be reported as a desktop L3 pass.

The real process smoke must run from an interactive Windows x64 or macOS arm64
desktop session. Explicitly acknowledge that condition and run:

```powershell
$env:AW_L3_INTERACTIVE_DESKTOP = '1'
pnpm test:l3:tauri-process
```

The gate builds a debug Tauri binary and sidecars, assigns a unique temporary
Agent data root, launches the actual GUI process, observes exactly one new Agent
from the expected binary, closes only the spawned UI process, and verifies that
the isolated Agent remains alive. It then stops only that Agent and removes the
validated temporary directory. Existing developer Agent processes are never
selected for cleanup.

This process gate still does not prove installer code signing, macOS
notarization, real Credential Manager/Keychain prompts, a system-browser PKCE
round trip, signed updater installation/restart, or OS-login Agent startup.
Those require signed artifacts, configured identity infrastructure and the
target-machine release checklist; a debug process smoke must never be reported
as evidence for them.

`pnpm test:l3` runs the Compose-backed infrastructure stage, Federation CSP
browser L3 and the desktop preflight. The console explicitly reports the Tauri
GUI gate as `NOT RUN` unless
`-TauriProcessSmoke` is requested.
