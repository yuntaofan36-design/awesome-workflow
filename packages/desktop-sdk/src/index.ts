import { AppletEventSchema, type AppletEvent } from '@awesome-workflow/contracts';

import {
  DESKTOP_RPC_PROTOCOL_VERSION,
  DesktopClient as CoreDesktopClient,
  type DesktopTaskContext,
} from './core.js';
import { NodeLocalRpcTransport } from './node.js';

export * from './core.js';
export { NodeLocalRpcTransport } from './node.js';

export function getTaskContext(environment: NodeJS.ProcessEnv = process.env): DesktopTaskContext {
  const protocolVersion = Number(environment.AW_PROTOCOL_VERSION);
  const appId = environment.AW_APP_ID;
  const taskId = environment.AW_TASK_ID;
  const lease = environment.AW_LEASE;
  const rpcEndpoint = environment.AW_RPC_ENDPOINT;
  const workDirectory = environment.AW_WORK_DIRECTORY;
  if (
    protocolVersion !== DESKTOP_RPC_PROTOCOL_VERSION ||
    !appId ||
    !taskId ||
    !lease ||
    !rpcEndpoint ||
    !workDirectory
  ) {
    throw new Error('This process was not started by a compatible Awesome Workflow runner');
  }

  return { protocolVersion, appId, taskId, lease, rpcEndpoint, workDirectory };
}

/**
 * Node convenience client. Browser Web UI applets must use createWebUiClient
 * from the explicit `@awesome-workflow/desktop-sdk/browser` entrypoint.
 */
export class DesktopClient extends CoreDesktopClient {
  constructor(
    transport: import('./core.js').DesktopRpcTransport = new NodeLocalRpcTransport(),
    context: DesktopTaskContext = getTaskContext(),
  ) {
    super(transport, context);
  }
}

/**
 * Stdout events are the portable baseline for Python/native applets. Prefer the
 * typed DesktopClient when a Host transport implementation is available.
 */
export function emitEvent(event: AppletEvent): void {
  const validEvent = AppletEventSchema.parse(event);
  process.stdout.write(`AW_EVENT ${JSON.stringify(validEvent)}\n`);
}

export function log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
  emitEvent({ type: 'log', level, message });
}

export function reportProgress(value: number, label?: string): void {
  emitEvent({ type: 'progress', value, ...(label ? { label } : {}) });
}
