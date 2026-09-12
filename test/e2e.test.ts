import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import WebSocket from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('forwards a real Streamable HTTP MCP call through an authenticated agent', { timeout: 90_000 }, async (t) => {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(relayRoot, 'dist/server/index.js')], {
    cwd: relayRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_API_KEY: 'mcp-e2e-token',
      AGENT_TOKEN: 'agent-e2e-token',
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      MCP_ALLOWED_ORIGINS: 'http://127.0.0.1',
      TOOL_CALL_TIMEOUT_MS: '2000',
      TARGET_DEVICE_ID: 'e2e-pc',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => stopProcess(server));

  await waitForOutput(server, 'HTTP listening');

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthorized.status, 401);
  const badHost = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer mcp-e2e-token',
      'content-type': 'application/json',
      Host: 'evil.example.com',
    },
    body: '{}',
  });
  assert.ok([400, 403].includes(badHost.status), `unexpected bad Host status: ${badHost.status}`);

  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: 'Bearer agent-e2e-token', 'X-Desktop-Commander-Device-Id': 'e2e-pc' },
  });
  t.after(async () => closeWebSocket(agent));
  await once(agent, 'open');
  agent.send(JSON.stringify({
    type: 'hello',
    protocol: 1,
    deviceId: 'e2e-pc',
    deviceName: 'E2E PC',
    agentVersion: 'test',
    tools: [{
      name: 'echo',
      description: 'Echo test text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    }],
  }));
  await waitForAgentMessage(agent, (message) => message.type === 'hello_ack');

  agent.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (message.type !== 'tool_call') return;
    const args = message.arguments as { text?: string };
    agent.send(JSON.stringify({
      type: 'tool_result',
      id: message.id,
      ok: true,
      result: {
        content: [{ type: 'text', text: args.text ?? '' }],
        structuredContent: { echoed: args.text ?? '' },
      },
    }));
  });

  const createClient = (mode?: 'auto') => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer mcp-e2e-token' } },
    });
    const client = new Client(
      { name: 'desktop-commander-relay-e2e', version: '1.0.0' },
      mode ? { capabilities: {}, versionNegotiation: { mode } } : { capabilities: {} },
    );
    return client.connect(transport).then(() => ({ client, transport }));
  };

  const legacy = await createClient();
  t.after(async () => legacy.client.close().catch(() => undefined));
  const legacyTools = await legacy.client.listTools();
  assert.ok(legacyTools.tools.some((tool) => tool.name === 'echo'));
  const legacyResult = await legacy.client.callTool({ name: 'echo', arguments: { text: 'legacy' } });
  assert.deepEqual(legacyResult.structuredContent, { echoed: 'legacy' });
  assert.equal(legacyResult.content?.[0]?.type, 'text');

  const modern = await createClient('auto');
  t.after(async () => modern.client.close().catch(() => undefined));
  const modernResult = await modern.client.callTool({ name: 'echo', arguments: { text: 'modern' } });
  assert.deepEqual(modernResult.structuredContent, { echoed: 'modern' });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForOutput(process: ChildProcess, needle: string): Promise<void> {
  const streams = [process.stdout, process.stderr].filter(Boolean) as NodeJS.ReadableStream[];
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(needle)) {
        for (const stream of streams) stream.off('data', onData);
        resolve();
      }
    };
    for (const stream of streams) stream.on('data', onData);
    process.once('error', reject);
    process.once('exit', (code) => reject(new Error(`Relay exited before readiness (${code}): ${output}`)));
  });
}

async function waitForAgentMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!predicate(message)) return;
        socket.off('message', onMessage);
        resolve();
      } catch (error) {
        socket.off('message', onMessage);
        reject(error);
      }
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await once(socket, 'close').catch(() => undefined);
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await once(process, 'exit').catch(() => undefined);
}
