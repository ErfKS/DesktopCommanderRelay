import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await freePort();
const mcpToken = `mcp-real-${process.pid}`;
const agentToken = `agent-real-${process.pid}`;
const testUserProfile = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-relay-e2e-'));
let server;
let agent;
let client;

try {
  server = spawn(process.execPath, [path.join(relayRoot, 'dist/server/index.js')], {
    cwd: relayRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_API_KEY: mcpToken,
      AGENT_TOKEN: agentToken,
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      MCP_ALLOWED_ORIGINS: 'http://127.0.0.1',
      TOOL_CALL_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForLine(server, 'HTTP listening', 90_000);

  const agentEnv = {
    ...process.env,
    RELAY_WS_URL: `ws://127.0.0.1:${port}/agent`,
    AGENT_TOKEN: agentToken,
    DEVICE_ID: 'real-upstream-pc',
    DESKTOP_COMMANDER_COMMAND: 'this-command-must-not-win',
    DESKTOP_COMMANDER_ARGS_JSON: '[]',
    AGENT_TOOL_REFRESH_MS: '0',
    USERPROFILE: testUserProfile,
    APPDATA: path.join(testUserProfile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(testUserProfile, 'AppData', 'Local'),
  };
  delete agentEnv.DESKTOP_COMMANDER_ENTRY;
  agent = spawn(process.execPath, [path.join(relayRoot, 'dist/agent/index.js')], {
    cwd: relayRoot,
    env: agentEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForLine(agent, 'relay connected and authenticated', 90_000);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  });
  client = new Client({ name: 'desktop-commander-relay-real-e2e', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  if (!names.has('get_config')) throw new Error('Real upstream tool get_config was not discovered through the relay');
  const result = await client.callTool({ name: 'get_config', arguments: {} });
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new Error('Real upstream get_config returned no MCP content');
  }
  console.log(`REAL_E2E_PASS tools=${tools.tools.length} called=get_config content_blocks=${result.content.length}`);
} finally {
  await client?.close().catch(() => undefined);
  await stop(agent);
  await stop(server);
  await fs.rm(testUserProfile, { recursive: true, force: true });
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  const result = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => socket.close(resolve));
  return result;
}

async function waitForLine(child, needle, timeoutMs) {
  const streams = [child.stdout, child.stderr].filter(Boolean);
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${needle}'. Output:\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes(needle)) return;
      clearTimeout(timer);
      for (const stream of streams) stream.off('data', onData);
      resolve();
    };
    for (const stream of streams) stream.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited with ${code} while waiting for '${needle}'. Output:\n${output}`));
    });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000)),
  ]);
}
