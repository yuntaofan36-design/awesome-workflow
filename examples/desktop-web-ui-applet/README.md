# Hello static web-UI desktop applet

This example contains framework-free HTML, CSS, and JavaScript plus a
package-ready `web-ui` manifest for Windows x64 and macOS arm64. The static
artifact is platform-neutral, so both runtime targets reference the same
artifact declaration.

Preview the visual assets directly without a Host runtime:

```powershell
Start-Process .\examples\desktop-web-ui-applet\web\index.html
```

This preview proves only the static UI. The repository now implements the
code-level runtime slice: a per-task loopback HTTP origin, dedicated incognito
child WebView, fragment-delivered task bootstrap, fixed same-origin RPC path and
stop/revoke lifecycle. Automated tests cover the isolation and protocol
boundaries, but a real WebView2/WKWebView launch-and-close smoke test is still a
target-machine acceptance gate. Manifest validation or a browser preview must
not be reported as successful real Host execution.

`allowedOrigins` is empty because this sample makes no network requests. The
current Web UI CSP permits only same-origin Agent RPC; the manifest's external
origin list is reserved until the capability-checked HTTP broker is enabled.
The page has a restrictive CSP and does not attempt to read Host DOM, cookies,
tokens, or filesystem state. A bundled applet that uses Host RPC should create
its client at the very start of execution with
`@awesome-workflow/desktop-sdk/browser`, which consumes and scrubs the one-time
URL fragment before other application code runs.

## Publication boundary

Package the portable static artifact, replace every unsigned template field
from immutable bytes, and publish it through the supported workflow:

```powershell
pnpm aw package --manifest .\examples\desktop-web-ui-applet\applet.json `
  --artifact-map .\examples\desktop-web-ui-applet\aw.package.json `
  --output .\.artifacts\desktop-web-ui-applet --key-id publisher-2026 `
  --private-key C:\secure\publisher.pem
pnpm aw publish --application-id 00000000-0000-4000-8000-000000000001 `
  --package .\.artifacts\desktop-web-ui-applet\package.json
```

The checked-in Manifest has an explicit unsigned sentinel, not a fabricated
publisher signature. `aw package` emits the real signature, artifact digest,
artifact-set integrity and per-artifact SBOM from the static bytes.
