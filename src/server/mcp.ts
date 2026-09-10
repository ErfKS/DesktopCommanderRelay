import { createMcpHandler as createMcpHandlerV2, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import { DeviceRegistry } from './device-registry.js';
import { RELAY_VERSION } from '../shared/version.js';
import { isJsonObject, type ToolDefinition } from '../shared/protocol.js';

const RELAY_STATUS_TOOL: ToolDefinition = {
  name: 'relay_status',
  description: 'Show Desktop Commander relay status and the currently selected device.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const RELAY_LIST_DEVICES_TOOL: ToolDefinition = {
  name: 'relay_list_devices',
  description: 'List Desktop Commander agents currently connected to this private relay.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function normalizeRemoteResult(value: unknown): CallToolResult {
  if (isJsonObject(value) && Array.isArray(value.content)) return value as unknown as CallToolResult;
  return textResult(JSON.stringify(value, null, 2));
}

export function createMcpServer(registry: DeviceRegistry): Server {
  const server = new Server(
    { name: 'desktop-commander-relay', version: RELAY_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [RELAY_STATUS_TOOL, RELAY_LIST_DEVICES_TOOL, ...registry.listMcpTools()] as Tool[],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name;
    if (name === 'relay_status') {
      return textResult(JSON.stringify({
        ok: true,
        selected_device: registry.getSelectedDevice()?.id ?? null,
        selection_problem: registry.selectionProblem(),
        connected_devices: registry.listDevices().length,
      }, null, 2));
    }
    if (name === 'relay_list_devices') {
      return textResult(JSON.stringify(registry.listDevices(), null, 2));
    }

    try {
      const rawArgs = request.params.arguments;
      const args = isJsonObject(rawArgs) ? rawArgs : {};
      const result = await registry.callTool(name, args, { transport: 'desktop-commander-relay' });
      return normalizeRemoteResult(result);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  return server;
}

export function createMcpRequestHandler(registry: DeviceRegistry): NodeMcpRequestHandler {
  const mcpHandler = createMcpHandlerV2(
    () => createMcpServer(registry),
    { legacy: 'stateless' },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler);
  return async (req, res, parsedBody) => nodeMcpHandler(req, res, parsedBody);
}

export async function handleMcpRequest(req: Request, res: Response, registry: DeviceRegistry): Promise<void> {
  await createMcpRequestHandler(registry)(req, res, req.body);
}
