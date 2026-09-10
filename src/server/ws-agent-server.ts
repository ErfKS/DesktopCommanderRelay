import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authorizeAgentUpgrade } from './auth.js';
import { DeviceRegistry } from './device-registry.js';
import { isAllowedHostHeader, isAllowedOriginHeader, normalizeDeviceId } from '../shared/security.js';
import { parseAgentMessage, sanitizeToolDefinition } from '../shared/protocol.js';
import { RELAY_PROTOCOL_VERSION, RELAY_VERSION } from '../shared/version.js';

interface AgentSocket extends WebSocket {
  isAlive?: boolean;
  deviceId?: string;
}

export class AgentWebSocketServer {
  private readonly wss: WebSocketServer;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly httpServer: HttpServer,
    private readonly registry: DeviceRegistry,
    private readonly path: string,
    private readonly agentToken: string | undefined,
    private readonly allowInsecureLocal: boolean,
    private readonly helloTimeoutMs: number,
    maxPayloadBytes: number,
    private readonly heartbeatMs: number,
    private readonly allowedHostnames: readonly string[],
    private readonly allowedOriginHostnames: readonly string[],
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  }

  start(): void {
    this.httpServer.on('upgrade', this.onUpgrade);
    this.wss.on('connection', this.onConnection);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  async close(): Promise<void> {
    this.httpServer.off('upgrade', this.onUpgrade);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.wss.clients) {
      try { client.close(1001, 'Relay shutting down'); } catch { /* best effort */ }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isAllowedHostHeader(req.headers.host, this.allowedHostnames)
      || !isAllowedOriginHeader(req.headers.origin, this.allowedOriginHostnames)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!authorizeAgentUpgrade(req, this.agentToken, this.allowInsecureLocal)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  };

  private onConnection = (socket: WebSocket, req: IncomingMessage): void => {
    const ws = socket as AgentSocket;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; if (ws.deviceId) this.registry.touch(ws.deviceId); });

    const headerDeviceId = Array.isArray(req.headers['x-desktop-commander-device-id'])
      ? req.headers['x-desktop-commander-device-id'][0]
      : req.headers['x-desktop-commander-device-id'];

    let expectedDeviceId: string | undefined;
    try {
      if (headerDeviceId) expectedDeviceId = normalizeDeviceId(headerDeviceId);
    } catch {
      ws.close(1008, 'Invalid device id');
      return;
    }

    const helloTimer = setTimeout(() => ws.close(1008, 'Hello timeout'), this.helloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'Binary messages are not supported');
        return;
      }
      try {
        const message = parseAgentMessage(data.toString());
        if (message.type === 'hello') {
          const deviceId = normalizeDeviceId(message.deviceId);
          if (expectedDeviceId && expectedDeviceId !== deviceId) {
            ws.close(1008, 'Device id does not match authenticated header');
            return;
          }
          if (ws.deviceId && ws.deviceId !== deviceId) {
            ws.close(1008, 'Device id cannot change during a connection');
            return;
          }

          const tools = new Map(
            message.tools
              .map(sanitizeToolDefinition)
              .filter((tool): tool is NonNullable<typeof tool> => !!tool)
              .map((tool) => [tool.name, tool]),
          );

          ws.deviceId = deviceId;
          clearTimeout(helloTimer);
          this.registry.register({
            id: deviceId,
            name: message.deviceName || deviceId,
            socket: ws,
            tools,
            connectedAt: new Date(),
            lastSeenAt: new Date(),
          });
          ws.send(JSON.stringify({
            type: 'hello_ack',
            protocol: RELAY_PROTOCOL_VERSION,
            serverVersion: RELAY_VERSION,
          }));
          console.error(`[relay] agent connected: ${deviceId} (${tools.size} tools)`);
          return;
        }

        if (!ws.deviceId) {
          ws.close(1008, 'Hello required before other messages');
          return;
        }
        if (message.type === 'tool_result') this.registry.handleToolResult(ws.deviceId, message);
      } catch (error) {
        console.error('[relay] invalid agent message:', error instanceof Error ? error.message : String(error));
        ws.close(1007, 'Invalid message');
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (ws.deviceId) {
        this.registry.unregister(ws.deviceId, ws);
        console.error(`[relay] agent disconnected: ${ws.deviceId}`);
      }
    });

    ws.on('error', (error) => {
      console.error('[relay] agent websocket error:', error.message);
    });
  };

  private heartbeat(): void {
    for (const socket of this.wss.clients) {
      const ws = socket as AgentSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }
}
