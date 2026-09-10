import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentMessage, sanitizeToolDefinition } from '../src/shared/protocol.js';

test('accepts a valid hello', () => {
  const msg = parseAgentMessage(JSON.stringify({
    type: 'hello', protocol: 1, deviceId: 'pc', deviceName: 'PC', agentVersion: '0.1.0', tools: [],
  }));
  assert.equal(msg.type, 'hello');
});

test('sanitizes MCP tool definitions', () => {
  const tool = sanitizeToolDefinition({
    name: 'read_file', description: 'Read', inputSchema: { type: 'object' }, unsafeExtra: 'drop-me',
  });
  assert.deepEqual(tool, {
    name: 'read_file', description: 'Read', inputSchema: { type: 'object' },
  });
});

test('rejects malformed or oversized agent messages', () => {
  assert.throws(() => parseAgentMessage(JSON.stringify({
    type: 'hello', protocol: 1, deviceId: 'pc', deviceName: 'PC', agentVersion: '0.1.0', tools: [
      { name: 'bad', inputSchema: [] },
    ],
  })));
  assert.throws(() => parseAgentMessage(JSON.stringify({
    type: 'tool_result', id: 'x'.repeat(201), ok: true,
  })));
});

test('bounds tool definitions and preserves supported MCP metadata', () => {
  const tool = sanitizeToolDefinition({
    name: 'run',
    title: 'Run',
    description: 'Run a command',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: false },
    _meta: { source: 'local' },
  });
  assert.deepEqual(tool, {
    name: 'run',
    title: 'Run',
    description: 'Run a command',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: false },
    _meta: { source: 'local' },
  });
  assert.equal(sanitizeToolDefinition({ name: 'x'.repeat(201), inputSchema: {} }), null);
});
