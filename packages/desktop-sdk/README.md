# `@awesome-workflow/desktop-sdk`

Desktop applets receive a short-lived task lease, never a platform login token.
The Agent binds every request to protocol version, app ID, task ID, lease and
method. Native/Python applets and browser-based Web UI applets use separate,
local-only transports.

## Native and Python applets

```ts
import { DesktopClient, NodeLocalRpcTransport } from '@awesome-workflow/desktop-sdk';

const client = new DesktopClient(new NodeLocalRpcTransport());
const context = await client.readContext();

await client.appendLog(`working in ${context.workDirectory}`);
await client.setProgress(0.5, 'half way');
```

`DesktopClient` reads the Host-injected `AW_*` task coordinates by default. Do
not print or forward `client.context.lease`; it is valid only for the local Agent
and current task.

## Web UI applets

Use the browser-only entrypoint so a browser bundle never imports `node:net`:

```ts
import { createWebUiClient } from '@awesome-workflow/desktop-sdk/browser';

// Run this before application routing, logging or other startup code. It reads
// the one-time #aw-task bootstrap and immediately removes it from the URL.
const client = createWebUiClient();
const context = await client.readContext();

await client.appendLog(`opened ${context.appId}`);
```

The browser transport accepts only the exact Agent origin
`http://127.0.0.1:<task-port>` and the fixed
`/__awesome_workflow/rpc` endpoint. Requests omit cookies and referrers, reject
redirects, and validate the bounded JSON response. Do not copy, persist, print,
or forward `client.context.lease`; the URL bootstrap is a bearer secret even
though it is task-scoped and short-lived.

`context-read`, bounded log append and progress are implemented in the minimal
Host. Workspace, HTTP, notification and subprocess methods remain fail-closed
until their capability-specific brokers are implemented.
