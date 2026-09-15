import os from 'node:os';
import WebSocket from 'ws';
import { LocalDesktopCommander } from './local-desktop-commander.js';
import { captureLinuxScreenshot } from './screenshot.js';
import { envInt, envOptional, envString } from '../shared/env.js';
import {
  isJsonObject,
  MAX_CALL_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  RELAY_CAPTURE_SCREENSHOT_TOOL,
  RELAY_CAPTURE_SCREENSHOT_TOOL_DEFINITION,
  type ToolCallMessage,
  type ToolDefinition,
  type ToolResultMessage,
} from '../shared/protocol.js';
import { normalizeDeviceId } from '../shared/security.js';
import { RELAY_PROTOCOL_VERSION, RELAY_VERSION } from '../shared/version.js';

export class RelayAgent {
  private readonly local = new LocalDesktopCommander();
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectDelay: number;
  private activeCalls = 0;
  private queue: QueuedCall[] = [];
  private readonly resultCache = new Map<string, ToolResultMessage>();
  private readonly inFlight = new Map<string, Promise<ToolResultMessage>>();
  private refreshTimer: NodeJS.Timeout | null = null;

  private readonly relayUrl = envString('RELAY_WS_URL');
  private readonly token = envString('AGENT_TOKEN');
  private readonly deviceId = normalizeDeviceId(envString('DEVICE_ID', os.hostname()));
  private readonly deviceName = (envOptional('DEVICE_NAME') || os.hostname()).slice(0, 200);
  private readonly maxConcurrency = envInt('AGENT_MAX_CONCURRENCY', 4, 1);
  private readonly reconnectMin = envInt('AGENT_RECONNECT_MIN_MS', 1_000, 100);
  private readonly reconnectMax = envInt('AGENT_RECONNECT_MAX_MS', 30_000, 1_000);
  private readonly resultCacheSize = envInt('AGENT_RESULT_CACHE_SIZE', 100, 1);
  private readonly maxQueue = envInt('AGENT_MAX_QUEUE', 100, 0);
  private readonly toolRefreshMs = envInt('AGENT_TOOL_REFRESH_MS', 60_000, 0);
  private readonly wsMaxPayload = envInt('AGENT_WS_MAX_PAYLOAD_BYTES', 32 * 1024 * 1024, 1024);

  constructor() {
    this.reconnectDelay = this.reconnectMin;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.local.ensureConnected();
        await this.connectOnce();
        this.reconnectDelay = this.reconnectMin;
      } catch (error) {
        if (this.stopped) break;
        console.error('[agent] relay connection failed:', error instanceof Error ? error.message : String(error));
      }
      if (!this.stopped) {
        const jittered = Math.round(this.reconnectDelay * (0.75 + Math.random() * 0.5));
        await sleep(jittered);
        this.reconnectDelay = Math.min(this.reconnectMax, this.reconnectDelay * 2);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try { this.socket?.close(1000, 'Agent shutting down'); } catch { /* best effort */ }
    await this.local.close();
  }

  private async connectOnce(): Promise<void> {
    const tools = await this.listRelayTools();
    console.error(`[agent] connecting to relay ${this.relayUrl} as '${this.deviceId}' with ${tools.length} tools`);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Desktop-Commander-Device-Id': this.deviceId,
        },
        maxPayload: this.wsMaxPayload,
      });
      this.socket = ws;
      let acknowledged = false;
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      ws.on('open', () => {
        this.sendHello(ws, tools);
        if (this.toolRefreshMs > 0) {
          this.refreshTimer = setInterval(() => void this.refreshTools(ws), this.toolRefreshMs);
          this.refreshTimer.unref();
        }
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const message: unknown = JSON.parse(data.toString());
          if (!isJsonObject(message) || typeof message.type !== 'string') return;
          if (message.type === 'hello_ack') {
            if (message.protocol !== RELAY_PROTOCOL_VERSION) throw new Error('Unsupported relay protocol');
            acknowledged = true;
            console.error('[agent] relay connected and authenticated');
            return;
          }
          if (message.type === 'tool_call') {
            if (!acknowledged) return;
            const call = parseToolCall(message);
            this.acceptCall(call, ws);
          }
        } catch (error) {
          console.error('[agent] invalid relay message:', error instanceof Error ? error.message : String(error));
        }
      });

      ws.on('error', (error) => {
        if (!acknowledged) fail(error);
        else console.error('[agent] relay websocket error:', error.message);
      });
      ws.on('close', (code, reason) => {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        if (this.socket === ws) this.socket = null;
        this.dropQueuedCalls(ws);
        if (!settled) {
          settled = true;
          if (acknowledged) resolve();
          else reject(new Error(`Relay closed before hello acknowledgement (${code} ${reason.toString()})`));
        }
      });
    });
  }

  private drainQueue(): void {
    while (this.activeCalls < this.maxConcurrency && this.queue.length > 0) {
      const queued = this.queue.shift()!;
      this.activeCalls++;
      void this.executeCall(queued.call).then((message) => {
        this.rememberResult(message);
        this.sendResult(message, queued.socket);
        queued.resolve(message);
      }).finally(() => {
        this.inFlight.delete(queued.call.id);
        this.activeCalls--;
        this.drainQueue();
      });
    }
  }

  private async executeCall(call: ToolCallMessage): Promise<ToolResultMessage> {
    let message: ToolResultMessage;
    try {
      const result = call.name === RELAY_CAPTURE_SCREENSHOT_TOOL
        ? await captureLinuxScreenshot(readScreenshotLimit(call.arguments))
        : await this.local.callTool(call.name, call.arguments, call.metadata ?? {});
      message = { type: 'tool_result', id: call.id, ok: true, result };
    } catch (error) {
      message = {
        type: 'tool_result',
        id: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return message;
  }

  private acceptCall(call: ToolCallMessage, ws: WebSocket): void {
    const cached = this.resultCache.get(call.id);
    if (cached) {
      this.sendResult(cached, ws);
      return;
    }

    const existing = this.inFlight.get(call.id);
    if (existing) {
      void existing.then((message) => this.sendResult(message, ws));
      return;
    }

    if (this.queue.length >= this.maxQueue && this.activeCalls >= this.maxConcurrency) {
      const overloaded: ToolResultMessage = {
        type: 'tool_result',
        id: call.id,
        ok: false,
        error: 'Agent queue is full; call was not executed',
      };
      this.rememberResult(overloaded);
      this.sendResult(overloaded, ws);
      return;
    }

    let resolve!: (message: ToolResultMessage) => void;
    const completion = new Promise<ToolResultMessage>((done) => { resolve = done; });
    this.inFlight.set(call.id, completion);
    this.queue.push({ call, socket: ws, resolve });
    this.drainQueue();
  }

  private rememberResult(message: ToolResultMessage): void {
    this.resultCache.set(message.id, message);
    while (this.resultCache.size > this.resultCacheSize) {
      const oldest = this.resultCache.keys().next().value;
      if (oldest === undefined) break;
      this.resultCache.delete(oldest);
    }
  }

  private sendResult(message: ToolResultMessage, socket = this.socket): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message), (error) => {
      if (error) console.error('[agent] failed to send tool result:', error.message);
    });
  }

  private sendHello(socket: WebSocket, tools: ToolDefinition[]): void {
    socket.send(JSON.stringify({
      type: 'hello',
      protocol: RELAY_PROTOCOL_VERSION,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      agentVersion: RELAY_VERSION,
      tools,
    }));
  }

  private async refreshTools(socket: WebSocket): Promise<void> {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const tools = await this.listRelayTools();
      if (socket === this.socket && socket.readyState === WebSocket.OPEN) this.sendHello(socket, tools);
    } catch (error) {
      console.error('[agent] local tool refresh failed:', error instanceof Error ? error.message : String(error));
    }
  }

  private async listRelayTools(): Promise<ToolDefinition[]> {
    const tools = await this.local.listTools();
    return [
      ...tools.filter((tool) => tool.name !== RELAY_CAPTURE_SCREENSHOT_TOOL),
      RELAY_CAPTURE_SCREENSHOT_TOOL_DEFINITION,
    ];
  }

  private dropQueuedCalls(socket: WebSocket): void {
    const retained: QueuedCall[] = [];
    for (const queued of this.queue) {
      if (queued.socket === socket) this.inFlight.delete(queued.call.id);
      else retained.push(queued);
    }
    this.queue = retained;
  }
}

interface QueuedCall {
  call: ToolCallMessage;
  socket: WebSocket;
  resolve: (message: ToolResultMessage) => void;
}

function parseToolCall(value: Record<string, unknown>): ToolCallMessage {
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > MAX_CALL_ID_LENGTH ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > MAX_TOOL_NAME_LENGTH ||
    !isJsonObject(value.arguments)
  ) {
    throw new Error('Invalid tool_call message');
  }
  return {
    type: 'tool_call',
    id: value.id,
    name: value.name,
    arguments: value.arguments,
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readScreenshotLimit(args: Record<string, unknown>): number {
  const value = args.max_bytes;
  if (value === undefined) return 10 * 1024 * 1024;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid screenshot size limit');
  }
  return value;
}
