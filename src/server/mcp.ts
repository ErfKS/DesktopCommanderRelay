import { createMcpHandler as createMcpHandlerV2, Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import { DeviceRegistry } from './device-registry.js';
import type { McpOAuthContext } from './oauth.js';
import { RELAY_VERSION } from '../shared/version.js';
import { BROWSER_UI_HTML } from './browser-ui.js';

const BROWSER_UI_URI = 'ui://deskbridge-sandbox/browser';
const BROWSER_UI_MIME = 'text/html;profile=mcp-app';
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

const BROWSER_LAUNCH_TOOL: ToolDefinition = {
  name: 'browser_launch',
  description: 'Launch the DeskBridge Sandbox browser interface without navigating or changing the website.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function authError(context: McpOAuthContext, text: string, scope: string): CallToolResult {
  return {
    ...textResult(text, true),
    _meta: {
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${context.resourceMetadataUrl}", error="insufficient_scope", scope="${scope}", error_description="${text.replace(/"/g, '')}"`,
      ],
    },
  } as CallToolResult;
}

function normalizeRemoteResult(value: unknown): CallToolResult {
  if (isJsonObject(value) && Array.isArray(value.content)) return value as unknown as CallToolResult;
  return textResult(JSON.stringify(value, null, 2));
}

export function createMcpServer(
  registry: DeviceRegistry,
  oauthContext?: McpOAuthContext,
  oauthEnabled = false,
): Server {
  const server = new Server(
    { name: 'desktop-commander-relay', version: RELAY_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  const selectedDeviceId = registry.getSelectedDevice()?.id?.toLowerCase();
  const selectedDeviceAllowed = !oauthContext
    || (selectedDeviceId !== undefined && (oauthContext.allowedDeviceIds.has('*') || oauthContext.allowedDeviceIds.has(selectedDeviceId)));

  server.setRequestHandler('resources/list', async () => ({
    resources: [{ name: 'DeskBridge Sandbox Browser', uri: BROWSER_UI_URI, mimeType: BROWSER_UI_MIME }],
  }));
  server.setRequestHandler('resources/read', async (request) => {
    if (request.params.uri !== BROWSER_UI_URI) throw new Error('Unknown MCP App resource');
    return { contents: [{
      uri: BROWSER_UI_URI,
      mimeType: BROWSER_UI_MIME,
      text: BROWSER_UI_HTML,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } },
    }] };
  });

  server.setRequestHandler('tools/list', async () => ({
    tools: [RELAY_STATUS_TOOL, RELAY_LIST_DEVICES_TOOL, BROWSER_LAUNCH_TOOL, ...registry.listMcpTools()]
      .filter((tool) => {
        if (!oauthContext) return true;
        if (!oauthContext.allowedTools.has('*') && !oauthContext.allowedTools.has(tool.name)) return false;
        return tool.name === 'relay_status' || tool.name === 'relay_list_devices' || selectedDeviceAllowed;
      })
      .map((tool) => ({
        ...tool,
        ...(tool.name === 'browser_launch' ? {
          _meta: {
            ...tool._meta,
            ui: { resourceUri: BROWSER_UI_URI },
            'openai/ui': { entrypoints: [{ type: 'global' }] },
          },
        } : {}),
        ...(tool.name === 'browser_open' ? {
          _meta: { ...tool._meta, ui: { resourceUri: BROWSER_UI_URI } },
        } : {}),
        ...(oauthEnabled ? {
          securitySchemes: [{
            type: 'oauth2',
            scopes: tool.name === 'relay_status' || tool.name === 'relay_list_devices' || tool.name === 'browser_launch' ? ['mcp:read'] : ['mcp:write'],
          }],
        } : {}),
      })) as Tool[],
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name;
    if (name === 'browser_launch') {
      if (oauthContext && !oauthContext.scopes.has('mcp:read')) {
        return authError(oauthContext, 'OAuth read permission is required', 'mcp:read');
      }
      if (oauthContext && !oauthContext.allowedTools.has('*') && !oauthContext.allowedTools.has(name)) {
        return authError(oauthContext, 'Browser launcher is not allowed', 'mcp:read');
      }
      if (oauthContext && !selectedDeviceAllowed) {
        return authError(oauthContext, 'Selected device is not authorized', 'mcp:read');
      }
      return textResult('DeskBridge Sandbox browser interface ready.');
    }

    if (name === 'relay_status') {
      if (oauthContext && !oauthContext.scopes.has('mcp:read')) {
        return authError(oauthContext, 'OAuth read permission is required', 'mcp:read');
      }
      const visibleDevices = oauthContext
        ? registry.listDevices().filter((device) => typeof device.id === 'string' && (oauthContext.allowedDeviceIds.has('*') || oauthContext.allowedDeviceIds.has(device.id.toLowerCase())))
        : registry.listDevices();
      return textResult(JSON.stringify({
        ok: true,
        selected_device: oauthContext && !oauthContext.allowedDeviceIds.has('*') && !oauthContext.allowedDeviceIds.has(registry.getSelectedDevice()?.id.toLowerCase() ?? '')
          ? null
          : registry.getSelectedDevice()?.id ?? null,
        selection_problem: oauthContext && visibleDevices.length === 0 ? 'No OAuth-authorized device is connected.' : registry.selectionProblem(),
        connected_devices: visibleDevices.length,
      }, null, 2));
    }
    if (name === 'relay_list_devices') {
      if (oauthContext && !oauthContext.scopes.has('mcp:read')) {
        return authError(oauthContext, 'OAuth read permission is required', 'mcp:read');
      }
      const devices = oauthContext
        ? registry.listDevices().filter((device) => typeof device.id === 'string' && (oauthContext.allowedDeviceIds.has('*') || oauthContext.allowedDeviceIds.has(device.id.toLowerCase())))
        : registry.listDevices();
      return textResult(JSON.stringify(devices, null, 2));
    }

    try {
      const rawArgs = request.params.arguments;
      const args = isJsonObject(rawArgs) ? rawArgs : {};
      if (oauthContext) {
        if (!oauthContext.scopes.has('mcp:write')) {
          return authError(oauthContext, 'OAuth write permission is required', 'mcp:write');
        }
        if (!oauthContext.allowedTools.has('*') && !oauthContext.allowedTools.has(name)) {
          return authError(oauthContext, `OAuth policy does not allow tool '${name}'`, 'mcp:write');
        }
        const selectedDeviceId = registry.getSelectedDevice()?.id?.toLowerCase();
        if (!selectedDeviceId || (!oauthContext.allowedDeviceIds.has('*') && !oauthContext.allowedDeviceIds.has(selectedDeviceId))) {
          return authError(oauthContext, 'OAuth policy does not allow the selected device', 'mcp:write');
        }
        if (typeof args.device_id === 'string' && args.device_id.toLowerCase() !== selectedDeviceId) {
          return authError(oauthContext, 'The requested device is not the authorized selected device', 'mcp:write');
        }
      }
      const result = await registry.callTool(name, args, { transport: 'desktop-commander-relay' });
      return normalizeRemoteResult(result);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  return server;
}

export function createMcpRequestHandler(
  registry: DeviceRegistry,
  getOAuthContext: (res: unknown) => McpOAuthContext | undefined = () => undefined,
  oauthEnabled = false,
): NodeMcpRequestHandler {
  return async (req, res, parsedBody) => {
    const mcpHandler = createMcpHandlerV2(
      () => createMcpServer(registry, getOAuthContext(res), oauthEnabled),
      { legacy: 'stateless' },
    );
    await toNodeHandler(mcpHandler)(req, res, parsedBody);
  };
}

export async function handleMcpRequest(req: Request, res: Response, registry: DeviceRegistry): Promise<void> {
  await createMcpRequestHandler(registry)(req, res, req.body);
}
