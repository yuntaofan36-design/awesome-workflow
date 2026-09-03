import type { SupportedLocale } from '@awesome-workflow/contracts';

export const DESKTOP_RPC_PROTOCOL_VERSION = 1 as const;

export type DesktopTaskContext = {
  protocolVersion: typeof DESKTOP_RPC_PROTOCOL_VERSION;
  appId: string;
  taskId: string;
  lease: string;
  rpcEndpoint: string;
  workDirectory: string;
  locale: SupportedLocale;
  fallbackLocales: SupportedLocale[];
};

export type DesktopRpcMethod =
  | 'context-read'
  | 'task-log-append'
  | 'task-progress'
  | 'workspace-read'
  | 'workspace-write'
  | 'http-request'
  | 'notification-show'
  | 'process-spawn';

export type DesktopRpcEnvelope<TPayload = unknown> = {
  protocolVersion: typeof DESKTOP_RPC_PROTOCOL_VERSION;
  appId: string;
  taskId: string;
  lease: string;
  method: DesktopRpcMethod;
  payload: TPayload;
};

export interface DesktopRpcTransport {
  /**
   * Sends one envelope to the Host-owned local transport. Implementations must not
   * forward the task lease to a remote control-plane or application endpoint.
   */
  request<TResult>(endpoint: string, envelope: DesktopRpcEnvelope): Promise<TResult>;
}

export type DesktopRpcResponse<TResult> = {
  protocolVersion: number;
  ok: boolean;
  data?: TResult;
  error?: string;
};

export class DesktopRpcError extends Error {}

export type HostTaskContext = {
  appId: string;
  taskId: string;
  workDirectory: string;
  workspaceDirectory?: string;
  arguments: string[];
  locale: SupportedLocale;
  fallbackLocales: SupportedLocale[];
};

export type WorkspaceReadRequest = {
  path: string;
  encoding?: 'utf8' | 'base64';
};

export type WorkspaceReadResult = {
  data: string;
  encoding: 'utf8' | 'base64';
};

export type WorkspaceWriteRequest = WorkspaceReadRequest & {
  data: string;
};

export type HostHttpRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  bodyBase64?: string;
};

export type HostHttpResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

export type ProcessSpawnRequest = {
  executable: string;
  args?: string[];
};

export type ProcessSpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class DesktopClient {
  readonly context: DesktopTaskContext;

  constructor(
    private readonly transport: DesktopRpcTransport,
    context: DesktopTaskContext,
  ) {
    this.context = context;
  }

  readContext(): Promise<HostTaskContext> {
    return this.call('context-read', {});
  }

  appendLog(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    return this.call('task-log-append', { level, message });
  }

  setProgress(value: number, label?: string): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('Progress must be between 0 and 1');
    }
    return this.call('task-progress', { value, ...(label ? { label } : {}) });
  }

  readWorkspace(request: WorkspaceReadRequest): Promise<WorkspaceReadResult> {
    return this.call('workspace-read', request);
  }

  writeWorkspace(request: WorkspaceWriteRequest): Promise<void> {
    return this.call('workspace-write', request);
  }

  requestHttp(request: HostHttpRequest): Promise<HostHttpResponse> {
    return this.call('http-request', request);
  }

  showNotification(title: string, body?: string): Promise<void> {
    return this.call('notification-show', { title, ...(body ? { body } : {}) });
  }

  spawnProcess(request: ProcessSpawnRequest): Promise<ProcessSpawnResult> {
    return this.call('process-spawn', request);
  }

  private call<TResult>(method: DesktopRpcMethod, payload: unknown): Promise<TResult> {
    const { protocolVersion, appId, taskId, lease, rpcEndpoint } = this.context;
    return this.transport.request<TResult>(rpcEndpoint, {
      protocolVersion,
      appId,
      taskId,
      lease,
      method,
      payload,
    });
  }
}
