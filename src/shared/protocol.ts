import { RELAY_PROTOCOL_VERSION } from './version.js';

export type JsonObject = Record<string, unknown>;

export const MAX_DEVICE_ID_LENGTH = 80;
export const MAX_DEVICE_NAME_LENGTH = 200;
export const MAX_AGENT_VERSION_LENGTH = 100;
export const MAX_TOOL_NAME_LENGTH = 200;
export const MAX_TOOL_COUNT = 1_000;
export const MAX_CALL_ID_LENGTH = 200;
export const MAX_ERROR_LENGTH = 4_000;

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export interface AgentHelloMessage {
  type: 'hello';
  protocol: number;
  deviceId: string;
  deviceName: string;
  agentVersion: string;
  tools: ToolDefinition[];
}

export interface ServerHelloMessage {
  type: 'hello_ack';
  protocol: number;
  serverVersion: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: JsonObject;
  metadata?: JsonObject;
}

export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type AgentToServerMessage = AgentHelloMessage | ToolResultMessage;
export type ServerToAgentMessage = ServerHelloMessage | ToolCallMessage | ErrorMessage;

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseAgentMessage(raw: string): AgentToServerMessage {
  const value: unknown = JSON.parse(raw);
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    throw new Error('Invalid relay message');
  }

  if (value.type === 'hello') {
    if (
      value.protocol !== RELAY_PROTOCOL_VERSION ||
      typeof value.deviceId !== 'string' ||
      typeof value.deviceName !== 'string' ||
      typeof value.agentVersion !== 'string' ||
      value.deviceId.length === 0 ||
      value.deviceId.length > MAX_DEVICE_ID_LENGTH ||
      value.deviceName.length > MAX_DEVICE_NAME_LENGTH ||
      value.agentVersion.length === 0 ||
      value.agentVersion.length > MAX_AGENT_VERSION_LENGTH ||
      !Array.isArray(value.tools) ||
      value.tools.length > MAX_TOOL_COUNT
    ) {
      throw new Error('Invalid hello message');
    }

    const tools = value.tools.map(sanitizeToolDefinition);
    if (tools.some((tool) => tool === null)) throw new Error('Invalid hello tool definition');
    return { ...value, tools: tools as ToolDefinition[] } as AgentHelloMessage;
  }

  if (value.type === 'tool_result') {
    if (
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      value.id.length > MAX_CALL_ID_LENGTH ||
      typeof value.ok !== 'boolean' ||
      (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > MAX_ERROR_LENGTH))
    ) {
      throw new Error('Invalid tool_result message');
    }
    return value as unknown as ToolResultMessage;
  }

  throw new Error(`Unsupported relay message type: ${value.type}`);
}

export function sanitizeToolDefinition(tool: unknown): ToolDefinition | null {
  if (
    !isJsonObject(tool) ||
    typeof tool.name !== 'string' ||
    !tool.name.trim() ||
    tool.name.length > MAX_TOOL_NAME_LENGTH
  ) return null;
  if (!isJsonObject(tool.inputSchema)) return null;

  const out: ToolDefinition = {
    name: tool.name,
    inputSchema: tool.inputSchema,
  };
  if (typeof tool.title === 'string') out.title = tool.title;
  if (typeof tool.description === 'string') out.description = tool.description;
  if (isJsonObject(tool.outputSchema)) out.outputSchema = tool.outputSchema;
  if (isJsonObject(tool.annotations)) out.annotations = tool.annotations;
  if (isJsonObject(tool._meta)) out._meta = tool._meta;
  return out;
}
