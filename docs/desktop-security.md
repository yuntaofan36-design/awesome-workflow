# Desktop trust and security model

## What the platform can enforce

- Signed artifact and manifest identity before install or run.
- Safe archive extraction and atomic activation.
- Host-mediated filesystem pickers, restricted HTTP broker, notifications,
  clipboard, shortcuts, lifecycle and log APIs.
- Task-scoped RPC leases and same-user local IPC access.
- Minimal process environment, working directory and explicit executable.
- User consent and re-review when a release requests more broker capabilities.
- One-shot privileged helper operations with exact arguments and audit events.

## What it cannot honestly promise

A Python process or native executable running as the user can call operating
system APIs outside the Host broker unless it is placed in an OS sandbox with
appropriate policy. Tauri does not change that fact. V2 therefore limits the
first release to workspace-trusted or officially reviewed signed native code.
Manifest permissions are a strong boundary for Host capabilities, not a claim
of complete OS confinement.

## Local protocol

Every request includes:

```json
{
  "protocolVersion": 1,
  "appId": "example-app",
  "taskId": "uuid",
  "lease": "opaque short-lived secret",
  "method": "task-log-append",
  "payload": {}
}
```

Unknown protocol versions, applications, tasks, callers, leases, methods and
capabilities fail closed. Python and native tasks use a same-user ACL named pipe
on Windows or Unix-domain socket on macOS. Neither channel carries the OIDC
refresh token.

Each Web UI task receives its own `127.0.0.1` random-port HTTP origin. That
server exposes only read-only `GET`/`HEAD` static assets and `POST
/__awesome_workflow/rpc`; it validates the exact Host and Origin, binds RPC to
the server's application/task identity, and reuses the same lease/method
authorization as native IPC. Canonical path containment rejects traversal,
hidden paths, directory listing and symlink escape. Static responses are
`no-store`, `nosniff`, non-frameable and carry a restrictive same-origin CSP.

The scoped lease enters only the child WebView URL fragment. The browser SDK
consumes and removes that fragment before parsing it, then permits RPC only to
the current loopback origin and fixed path with redirects, credentials and
referrers disabled. The Tauri management WebView receives neither this launch
URL nor native process leases. It creates a unique incognito child with no
Tauri capability, confines top-level navigation to the exact task origin and
denies new windows. Closing either side stops the task and revokes its lease;
the 30-minute task lease/server lifetime is the crash-recovery ceiling.

This keeps control-plane/OIDC credentials out of applets, but applet JavaScript
necessarily sees its own task lease after bootstrap. A hostile signed applet can
use its own granted task authority until stop/expiry, so publisher review and
least-privilege capabilities remain part of the trust model.
