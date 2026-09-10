import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { DeviceRegistry } from '../src/server/device-registry.js';

function fakeSocket() {
  const messages: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(payload: string, callback?: (error?: Error) => void) {
      messages.push(payload);
      callback?.();
    },
    close() {},
  } as unknown as WebSocket;
  return { socket, messages };
}

const tool = { name: 'echo', inputSchema: { type: 'object' } };

test('forwards a call and resolves the matching result', async () => {
  const registry = new DeviceRegistry(undefined, 500, 2);
  const fake = fakeSocket();
  registry.register({
    id: 'pc', name: 'PC', socket: fake.socket, tools: new Map([[tool.name, tool]]),
    connectedAt: new Date(), lastSeenAt: new Date(),
  });

  const pending = registry.callTool('echo', { value: 'hello' });
  assert.equal(fake.messages.length, 1);
  const request = JSON.parse(fake.messages[0]) as { type: string; id: string; name: string };
  assert.equal(request.type, 'tool_call');
  assert.equal(request.name, 'echo');
  registry.handleToolResult('pc', {
    type: 'tool_result', id: request.id, ok: true,
    result: { content: [{ type: 'text', text: 'hello' }], structuredContent: { value: 'hello' } },
  });
  assert.deepEqual(await pending, {
    content: [{ type: 'text', text: 'hello' }], structuredContent: { value: 'hello' },
  });
  registry.close();
});

test('bounds pending calls and rejects calls on timeout', async () => {
  const registry = new DeviceRegistry(undefined, 20, 1);
  const fake = fakeSocket();
  registry.register({
    id: 'pc', name: 'PC', socket: fake.socket, tools: new Map([[tool.name, tool]]),
    connectedAt: new Date(), lastSeenAt: new Date(),
  });

  const first = registry.callTool('echo', {});
  await assert.rejects(registry.callTool('echo', {}), /Too many in-flight/);
  await assert.rejects(first, /timed out/);
  registry.close();
});

test('a replacement connection rejects calls on the old connection', async () => {
  const registry = new DeviceRegistry('pc', 500, 2);
  const first = fakeSocket();
  const second = fakeSocket();
  const register = (fake: ReturnType<typeof fakeSocket>) => registry.register({
    id: 'pc', name: 'PC', socket: fake.socket, tools: new Map([[tool.name, tool]]),
    connectedAt: new Date(), lastSeenAt: new Date(),
  });
  register(first);
  const pending = registry.callTool('echo', {});
  register(second);
  await assert.rejects(pending, /replaced/);
  registry.close();
});
