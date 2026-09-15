import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { RELAY_CAPTURE_SCREENSHOT_TOOL, type JsonObject, type ToolDefinition, type ToolResultMessage } from '../shared/protocol.js';

export interface RegisteredDevice {
  id: string;
  name: string;
  socket: WebSocket;
  tools: Map<string, ToolDefinition>;
  connectedAt: Date;
  lastSeenAt: Date;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const RESERVED_TOOLS = new Set([
  'relay_status',
  'relay_list_devices',
  RELAY_CAPTURE_SCREENSHOT_TOOL,
]);

export class DeviceRegistry {
  private readonly devices = new Map<string, RegisteredDevice>();
  private readonly pending = new Map<string, Map<string, PendingCall>>();
  private closed = false;

  constructor(
    private readonly targetDeviceId: string | undefined,
    private readonly callTimeoutMs: number,
    private readonly maxPendingCalls: number,
  ) {}

  register(device: RegisteredDevice): void {
    if (this.closed) {
      try { device.socket.close(1001, 'Relay shutting down'); } catch { /* best effort */ }
      return;
    }
    const old = this.devices.get(device.id);
    if (old && old.socket !== device.socket) {
      try { old.socket.close(4001, 'Replaced by a newer connection'); } catch { /* best effort */ }
      this.rejectAllForDevice(device.id, new Error('Device connection was replaced'));
    }
    this.devices.set(device.id, old?.socket === device.socket
      ? { ...device, connectedAt: old.connectedAt }
      : device);
  }

  unregister(deviceId: string, socket: WebSocket): void {
    const current = this.devices.get(deviceId);
    if (!current || current.socket !== socket) return;
    this.devices.delete(deviceId);
    this.rejectAllForDevice(deviceId, new Error('Desktop Commander agent disconnected'));
  }

  touch(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.lastSeenAt = new Date();
  }

  listDevices(): Array<Record<string, unknown>> {
    return [...this.devices.values()].map((device) => ({
      id: device.id,
      name: device.name,
      connected: device.socket.readyState === WebSocket.OPEN,
      connected_at: device.connectedAt.toISOString(),
      last_seen_at: device.lastSeenAt.toISOString(),
      tool_count: device.tools.size,
      selected: this.getSelectedDevice()?.id === device.id,
    }));
  }

  getSelectedDevice(): RegisteredDevice | null {
    if (this.targetDeviceId) {
      const device = this.devices.get(this.targetDeviceId);
      return device?.socket.readyState === WebSocket.OPEN ? device : null;
    }
    if (this.devices.size === 1) {
      const device = this.devices.values().next().value;
      return device?.socket.readyState === WebSocket.OPEN ? device : null;
    }
    return null;
  }

  getDevice(deviceId: string): RegisteredDevice | null {
    const device = this.devices.get(deviceId);
    return device?.socket.readyState === WebSocket.OPEN ? device : null;
  }

  selectionProblem(): string | null {
    if (this.targetDeviceId && !this.getSelectedDevice()) {
      return `Configured TARGET_DEVICE_ID '${this.targetDeviceId}' is not connected.`;
    }
    if (!this.targetDeviceId && this.devices.size > 1) {
      return 'Multiple agents are connected. Set TARGET_DEVICE_ID on the relay server.';
    }
    if (this.devices.size === 0) return 'No Desktop Commander agent is connected.';
    return null;
  }

  listMcpTools(deviceId?: string): ToolDefinition[] {
    const device = deviceId ? this.getDevice(deviceId) : this.getSelectedDevice();
    if (!device) return [];
    return [...device.tools.values()].filter((tool) => !RESERVED_TOOLS.has(tool.name));
  }

  async callTool(
    name: string,
    args: JsonObject,
    metadata: JsonObject = {},
    deviceId?: string,
  ): Promise<unknown> {
    if (this.closed) throw new Error('Relay is shutting down');

    const device = deviceId
      ? this.getDevice(deviceId)
      : this.getSelectedDevice();

    if (!device) {
      if (deviceId) {
        throw new Error(`Device '${deviceId}' is not connected`);
      }

      throw new Error(this.selectionProblem() ?? 'No target device available');
    }
    if (!device.tools.has(name)) throw new Error(`Tool '${name}' is not available on device '${device.id}'`);
    if (device.socket.readyState !== WebSocket.OPEN) throw new Error(`Device '${device.id}' is not connected`);

    const id = randomUUID();
    const perDevice = this.pending.get(device.id) ?? new Map<string, PendingCall>();
    if (perDevice.size >= this.maxPendingCalls) {
      throw new Error(`Too many in-flight tool calls for device '${device.id}'`);
    }
    this.pending.set(device.id, perDevice);

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        perDevice.delete(id);
        reject(new Error(`Tool call timed out after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);

      perDevice.set(id, { resolve, reject, timer });
      try {
        device.socket.send(JSON.stringify({
          type: 'tool_call',
          id,
          name,
          arguments: args,
          metadata,
        }), (error) => {
          if (!error) return;
          clearTimeout(timer);
          perDevice.delete(id);
          if (perDevice.size === 0) this.pending.delete(device.id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        perDevice.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleToolResult(deviceId: string, message: ToolResultMessage): void {
    this.touch(deviceId);
    const perDevice = this.pending.get(deviceId);
    const call = perDevice?.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    perDevice!.delete(message.id);
    if (perDevice!.size === 0) this.pending.delete(deviceId);

    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(message.error || 'Remote tool call failed'));
  }

  close(): void {
    this.closed = true;
    for (const device of this.devices.values()) {
      try { device.socket.close(1001, 'Relay shutting down'); } catch { /* best effort */ }
    }
    for (const deviceId of this.pending.keys()) {
      this.rejectAllForDevice(deviceId, new Error('Relay shutting down'));
    }
    this.devices.clear();
  }

  private rejectAllForDevice(deviceId: string, error: Error): void {
    const perDevice = this.pending.get(deviceId);
    if (!perDevice) return;
    for (const call of perDevice.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.delete(deviceId);
  }
}
