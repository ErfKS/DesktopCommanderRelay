import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/server/mcp.js';
import { DeviceRegistry } from '../src/server/device-registry.js';
import type { McpOAuthContext } from '../src/server/oauth.js';
import type { ToolDefinition } from '../src/shared/protocol.js';

const fileTool: ToolDefinition = {
  name: 'read_file', description: 'Read one file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

test('OAuth MCP can explicitly route allowed calls across connected devices', async (t) => {
  const registry = new DeviceRegistry('webdade', 1000, 5);
  const requests: Array<{ target: string; name: string; args: Record<string, unknown> }> = [];

  function register(deviceId: string, extraTools: ToolDefinition[] = []) {
    const socket = {
      readyState: WebSocket.OPEN,
      send(payload: string, callback?: (error?: Error) => void) {
        const call = JSON.parse(payload) as { id: string; name: string; arguments: Record<string, unknown> };
        requests.push({ target: deviceId, name: call.name, args: call.arguments });
        callback?.();
        queueMicrotask(() => registry.handleToolResult(deviceId, {
          type: 'tool_result', id: call.id, ok: true,
          result: { content: [{ type: 'text', text: deviceId }] },
        }));
      },
      close() {},
    } as unknown as WebSocket;
    const tools = [fileTool, ...extraTools];
    registry.register({
      id: deviceId, name: deviceId, socket,
      tools: new Map(tools.map((tool) => [tool.name, tool])),
      connectedAt: new Date(), lastSeenAt: new Date(),
    });
  }

  register('webdade', [{ name: 'webdade_only', inputSchema: { type: 'object' } }]);
  register('pectin');

  const context: McpOAuthContext = {
    clientId: 'test', userId: 'owner',
    scopes: new Set(['mcp:read', 'mcp:write']),
    allowedTools: new Set(['relay_status', 'relay_list_devices', 'read_file', 'webdade_only']),
    allowedDeviceIds: new Set(['webdade', 'pectin']),
    resourceMetadataUrl: 'https://example.test/.well-known/oauth-protected-resource',
  };
  const server = createMcpServer(registry, context, true);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'multi-device-test', version: '1.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); registry.close(); });

  const tools = (await client.listTools()).tools;
  const readFile = tools.find((tool) => tool.name === 'read_file');
  assert.ok(readFile, 'read_file must be advertised');
  assert.deepEqual(readFile.inputSchema.properties?.device_id, {
    type: 'string', enum: ['webdade', 'pectin'],
    description: 'Required exact ID of the destination agent.',
  });
  assert.ok(readFile.inputSchema.required?.includes('device_id'));
  assert.ok(readFile.inputSchema.required?.includes('path'));

  const pectin = await client.callTool({
    name: 'read_file', arguments: { device_id: 'pectin', path: '/srv/example' },
  });
  assert.equal(pectin.content?.[0]?.type, 'text');
  assert.deepEqual(requests[0], { target: 'pectin', name: 'read_file', args: { path: '/srv/example' } });
  const webdade = await client.callTool({
    name: 'read_file', arguments: { device_id: 'webdade', path: '/tmp/test' },
  });
  assert.equal(webdade.isError, undefined);
  assert.equal(requests[1]?.target, 'webdade');
  const withoutId = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/test' } });
  assert.equal(withoutId.isError, true, 'missing device must not default to webdade');
  const forbidden = await client.callTool({
    name: 'read_file', arguments: { device_id: 'ai-core', path: '/tmp/test' },
  });
  assert.equal(forbidden.isError, true, 'a disallowed device must be rejected');
  assert.equal(requests.length, 2, 'blocked requests must not reach any agent');

  const webdadeOnly = tools.find((tool) => tool.name === 'webdade_only');
  assert.deepEqual(webdadeOnly?.inputSchema.properties?.device_id, {
    type: 'string', enum: ['webdade'],
    description: 'Required exact ID of the destination agent.',
  });
  const missingTool = await client.callTool({
    name: 'webdade_only', arguments: { device_id: 'pectin' },
  });
  assert.equal(missingTool.isError, true);
  assert.equal(requests.length, 2);

  const status = await client.callTool({ name: 'relay_list_devices', arguments: {} });
  assert.equal(status.isError, undefined);
});
