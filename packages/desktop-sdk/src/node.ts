import { createConnection } from 'node:net';

import {
  DESKTOP_RPC_PROTOCOL_VERSION,
  DesktopRpcError,
  type DesktopRpcEnvelope,
  type DesktopRpcResponse,
  type DesktopRpcTransport,
} from './core.js';

/** Node transport for the Agent's dedicated task socket (named pipe on Windows). */
export class NodeLocalRpcTransport implements DesktopRpcTransport {
  constructor(
    private readonly timeoutMs = 5_000,
    private readonly maxResponseBytes = 1024 * 1024,
  ) {}

  request<TResult>(endpoint: string, envelope: DesktopRpcEnvelope): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      let response = Buffer.alloc(0);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      const socket = createConnection(endpoint);
      socket.setTimeout(this.timeoutMs);
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(envelope)}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > this.maxResponseBytes) {
          finish(() => reject(new DesktopRpcError('Agent task RPC response exceeded the size limit')));
          return;
        }
        const newline = response.indexOf(0x0a);
        if (newline < 0) return;
        try {
          const decoded = JSON.parse(
            response.subarray(0, newline).toString('utf8'),
          ) as DesktopRpcResponse<TResult>;
          if (decoded.protocolVersion !== DESKTOP_RPC_PROTOCOL_VERSION) {
            throw new DesktopRpcError('Agent task RPC protocol version mismatch');
          }
          if (!decoded.ok) {
            throw new DesktopRpcError(decoded.error || 'Agent task RPC request was rejected');
          }
          finish(() => resolve(decoded.data as TResult));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once('timeout', () => {
        finish(() => reject(new DesktopRpcError('Agent task RPC request timed out')));
      });
      socket.once('error', (error) => finish(() => reject(error)));
      socket.once('end', () => {
        if (!settled) finish(() => reject(new DesktopRpcError('Agent closed task RPC without a response')));
      });
    });
  }
}
