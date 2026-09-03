# Awesome Workflow Desktop

The desktop host is a Tauri 2 management UI backed by a separate, persistent
per-user Agent. Closing the management UI does not stop native/background
micro-applications or the local scheduler. Interactive Web UI applets are tied
to their child windows and stop when those windows are closed.

## Process boundary

```text
React/Tauri UI -> authenticated local IPC -> Agent -> Runner -> applet process
                                      \-> SQLite state and schedule cache
```

- Tauri holds only an `AgentClient`; production has no in-process Agent fallback.
- Windows uses a named pipe with an owner/SYSTEM-only DACL plus a high-entropy
  bootstrap secret. Unix uses a `0600` socket inside a `0700` directory.
- The Agent owns immutable installation, version activation, tasks, leases,
  schedules and logs in SQLite.
- The Runner clears inherited environment variables and starts Python only from
  a Host-supplied absolute runtime path. Platform cookies and tokens are never
  passed to an applet.
- The elevated helper accepts only fixed service/autostart lifecycle actions;
  it is not a generic privileged command executor.

## Development

From the repository root:

```powershell
pnpm install
pnpm dev:desktop
```

The desktop Vite UI listens on `4303`; its control-plane API default is
`http://127.0.0.1:4100/api/v1`. `tauri dev` builds the debug Agent and Runner before
starting Vite. The host locates them beside the Tauri executable.

## Desktop authentication

Desktop sign-in is a public-client flow owned entirely by Rust:

1. bind an ephemeral IPv4 loopback callback on `127.0.0.1`;
2. generate a high-entropy PKCE verifier, S256 challenge and state;
3. ask `/api/v1/auth/cli/authorize` for the server-selected email or OIDC flow;
4. open that URL in the system browser and strictly validate the callback state;
5. exchange the one-time code and store the short-lived token in Windows
   Credential Manager or macOS Keychain.

The React WebView receives only the current user and expiry time. It cannot
supply an API origin, bearer token, custom header or arbitrary broker path, and
does not use cookies, local storage, files or in-WebView OTP state for the
desktop session. Provider availability comes from `/auth/providers`; only an
`active` descriptor is treated as usable. `configured` still means unavailable.

In debug builds, `AW_API_BASE_URL` can select a trusted API. Release builds read
that value only at compile time; otherwise the local default above is used.
Plain HTTP is accepted only for `localhost`/`127.0.0.1`; remote APIs require
HTTPS. Linux currently has no approved secret-store backend and therefore
fails closed instead of writing a credential file.

The keyring and browser/HTTP boundaries have mock-backed unit tests. Actual
Credential Manager/Keychain prompts, browser continuation, email delivery and
session revocation remain target-machine integration checks. Logging out always
deletes the local keyring entry first; remote bearer revocation additionally
depends on server endpoint support.

## Locale boundary

The management UI supports `system`, `en-US`, and `zh-CN`. It applies language
changes locally first, then sends only the resolved locale and bounded fallback
list through the authenticated `agent_set_locale` command. The user Agent
persists that snapshot in SQLite. A task copies the current snapshot when it is
created; Web UI context and Runner environment are read from that immutable
task copy, so closing the UI, going offline, restarting the Agent, or changing
the display language cannot silently change an existing run.

Python applets additionally need a Host-managed interpreter. In development,
set an absolute path before starting Tauri:

```powershell
$env:AW_PYTHON_RUNTIME = 'C:\absolute\managed-python\python.exe'
pnpm dev:desktop
```

See `../../examples/desktop-applet` for a minimal manifest and Python entrypoint.
Packaging and publishing use the repository's `aw package` / `aw publish` flow
or the Web Control Plane. The desktop UI intentionally does not duplicate the
presigned upload, validation, review and promotion state machine; a native UI
uploader is future work.

## Release bundle

```powershell
pnpm --filter @awesome-workflow/desktop tauri:build
```

Release builds require two public trust inputs at build time:

```powershell
$env:AW_DESKTOP_UPDATER_ENDPOINT = 'https://updates.example.com/awesome-workflow/{{target}}/{{arch}}/{{current_version}}'
$env:AW_DESKTOP_UPDATER_PUBLIC_KEY = '<Tauri updater public key>'
pnpm --filter @awesome-workflow/desktop tauri:build
```

`AW_DESKTOP_UPDATER_ENDPOINT` must be an HTTPS URL without credentials or a
fragment. `AW_DESKTOP_UPDATER_PUBLIC_KEY` is the verification key paired with
the CI-only `TAURI_SIGNING_PRIVATE_KEY`; it is public but still fixed into each
release binary. The pre-build generator writes the ignored
`src-tauri/tauri.release.conf.json`, and missing or malformed inputs stop the
release build. A browser preview has no updater commands. A debug Tauri build
without the generated endpoint/key configuration can render the page, but an
explicit check fails closed.

The GitHub release workflow supplies the endpoint and public key through
repository variables, supplies the updater private key and its password only
through secrets, and asks the Tauri release action to publish the signed
updater JSON. The HTTPS endpoint must return Tauri-compatible release metadata
whose download URL and signature refer to the immutable artifacts created by
that same release. Neither the UI nor an applet can override the endpoint,
target, headers, proxy, or key at runtime.

The Updates page never checks in the background. Checking metadata,
downloading, installing, and restarting are four explicit user actions. On
Windows, starting the installer can close the current UI before the install
call returns; the **Restart now** action is principally useful on platforms
where installation returns control to the running application.

The pre-build compiles release Agent, Runner and elevated-helper binaries and
stages them as Tauri resources. A production publisher public key can be
embedded by CI with `AW_SIGNING_KEY_ID` and `AW_SIGNING_PUBLIC_KEY` at Rust build
time. If neither an embedded key nor a packaged `trusted-signing-key.json` is
available, signed-package installation fails closed.

The signed Catalog manifest is delivered separately from the package and is the
installation trust root. Its selected `artifacts[]` entry declares the outer
`.awpkg` size and SHA-256; the artifact attestation signs that raw digest. The
`.awpkg` contains executable payload only, so no manifest hashes itself. After
verification and safe extraction, the Agent resolves `runtimes[].entry` from
the external manifest. A package-local `applet.json`, if present, is treated as
untrusted metadata and conflicting identity/capabilities are rejected.

A production Python runtime is intentionally not taken from user `PATH`; the
installer must stage an approved runtime under the application resources before
Python releases can run. Code-signing, Windows installer smoke tests, macOS
notarization, real signed-updater metadata/download/install/restart smoke tests,
and UI-exit/Agent-survival checks remain target-machine acceptance gates. Local
tests prove configuration validation and updater state transitions; they do not
prove a production signing service or target-machine installation.

The Agent is launched persistently when the desktop UI starts, but OS-login
Agent startup is not installed yet. Tauri UI autostart would start a visible UI
and is not an acceptable substitute. A future implementation needs a dedicated
headless startup helper plus explicit Windows per-user startup/macOS LaunchAgent
install and uninstall operations, followed by target-machine verification.

## Current security boundary

Task leases are scoped to protocol version, application, task and method. The
applet-facing local RPC currently exposes only context read, bounded log append
and progress reporting; other capabilities remain fail-closed. Web UI applets
run in a unique incognito child WebView against the Agent's per-task IPv4
loopback origin. Top-level navigation is confined to that exact origin, new
windows are denied, and the child matches none of the Tauri capabilities (the
management capability remains scoped to the `main` label only). The Rust host
consumes the Agent launch URL and task lease without returning either to the
management WebView. Closing the child stops the Agent task; an explicit task
stop closes the child, and window-creation failures trigger a compensating stop.

Unexpected process termination still depends on the Agent's bounded Web UI
lease/server expiry rather than a normal close callback. Process environment
isolation is present; Windows Job/AppContainer and macOS sandbox profiles remain
separate hardening work and must not be inferred from these checks.
