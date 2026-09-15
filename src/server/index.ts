import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { bearerMiddleware } from './auth.js';
import { DeviceRegistry } from './device-registry.js';
import { AgentWebSocketServer } from './ws-agent-server.js';
import { createMcpRequestHandler } from './mcp.js';
import { createActionRouter } from './action-api.js';
import { createImageBridgeFromEnv } from './image-bridge.js';
import { envBool, envInt, envOptional, envString, splitCsv } from '../shared/env.js';
import { normalizeDeviceId } from '../shared/security.js';
import { RELAY_VERSION } from '../shared/version.js';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';

const host = envString('HOST', '127.0.0.1');
const port = envInt('PORT', 8787, 1);
const mcpPath = envString('MCP_PATH', '/mcp');
const agentPath = envString('AGENT_WS_PATH', '/agent');
const allowInsecureLocal = envBool('ALLOW_INSECURE_LOCAL', false);
const mcpApiKey = envOptional('MCP_API_KEY');
const agentToken = envOptional('AGENT_TOKEN');
const actionApiKey = envOptional('ACTION_API_KEY');
const actionPath = envString('ACTION_PATH', '/action');
const imagePublicBaseUrl = envOptional('IMAGE_BRIDGE_PUBLIC_BASE_URL');
const targetDeviceId = envOptional('TARGET_DEVICE_ID') ? normalizeDeviceId(envString('TARGET_DEVICE_ID')) : undefined;
const callTimeoutMs = envInt('TOOL_CALL_TIMEOUT_MS', 300_000, 1_000);
const wsMaxPayload = envInt('WS_MAX_PAYLOAD_BYTES', 32 * 1024 * 1024, 1024);
const maxPendingCalls = envInt('MAX_PENDING_CALLS_PER_DEVICE', 64, 1);
const httpBodyLimit = envString('HTTP_BODY_LIMIT', '32mb');
const helloTimeoutMs = envInt('AGENT_HELLO_TIMEOUT_MS', 10_000, 1_000);
const heartbeatMs = envInt('WS_HEARTBEAT_MS', 20_000, 5_000);
const configuredHosts = splitCsv(envOptional('MCP_ALLOWED_HOSTS'));
const allowedHostnames = configuredHosts.length > 0 ? configuredHosts : ['localhost', '127.0.0.1', '[::1]'];
const configuredOrigins = splitCsv(envOptional('MCP_ALLOWED_ORIGINS'));
const allowedOriginHostnames = configuredOrigins.length > 0
  ? configuredOrigins.map((origin) => {
      try { return new URL(origin).hostname; } catch { return origin; }
    })
  : allowedHostnames;

const publicHost = ['0.0.0.0', '::'].includes(host);
if ((!mcpApiKey || !agentToken) && !(allowInsecureLocal && !publicHost)) {
  throw new Error('MCP_API_KEY and AGENT_TOKEN are required unless ALLOW_INSECURE_LOCAL=true on a loopback bind');
}
if (publicHost && configuredHosts.length === 0) {
  throw new Error('MCP_ALLOWED_HOSTS is required when HOST is public; set it to the public relay hostname(s)');
}

const registry = new DeviceRegistry(targetDeviceId, callTimeoutMs, maxPendingCalls);
const imageBridge = createImageBridgeFromEnv(registry);
await imageBridge.start();
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: RELAY_VERSION, devices: registry.listDevices().length });
});

app.get('/i/:token.:extension', async (req, res) => {
  try {
    const image = await imageBridge.serve(req.params.token, req.params.extension);
    if (!image) {
      res.status(404).json({ error: 'Image not found or expired' });
      return;
    }
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Content-Length', image.data.byteLength);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(image.data);
  } catch (error) {
    console.error('[relay] image bridge serving failed:', error instanceof Error ? error.message : String(error));
    res.status(404).json({ error: 'Image not found or expired' });
  }
});

app.use(
  actionPath,
  createActionRouter(
    registry,
    actionApiKey,
    allowInsecureLocal,
    httpBodyLimit,
    imageBridge,
    imagePublicBaseUrl,
  ),
);

const mcpRequestHandler = createMcpRequestHandler(registry);
const validateMcpHost = hostHeaderValidation(allowedHostnames);
const validateMcpOrigin = originValidation(allowedOriginHostnames);
app.all(mcpPath, bearerMiddleware(mcpApiKey, allowInsecureLocal), (req, res, next) => {
  if (!validateMcpHost(req, res)) return;
  if (!validateMcpOrigin(req, res)) return;
  next();
}, express.json({ limit: httpBodyLimit, type: ['application/json', 'application/*+json'] }), async (req, res) => {
  try {
    await mcpRequestHandler(req, res, req.body);
  } catch (error) {
    console.error('[relay] MCP request failed:', error instanceof Error ? error.message : String(error));
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
    }
  }
});

const httpServer = http.createServer(app);
const agentServer = new AgentWebSocketServer(
  httpServer,
  registry,
  agentPath,
  agentToken,
  allowInsecureLocal,
  helloTimeoutMs,
  wsMaxPayload,
  heartbeatMs,
  allowedHostnames,
  allowedOriginHostnames,
);
agentServer.start();

httpServer.listen(port, host, () => {
  console.error(`[relay] Desktop Commander Relay ${RELAY_VERSION}`);
  console.error(`[relay] HTTP listening on http://${host}:${port}${mcpPath}`);
  console.error(`[relay] Agent WebSocket path: ${agentPath}`);
  if (targetDeviceId) console.error(`[relay] Target device: ${targetDeviceId}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[relay] ${signal}: shutting down`);
  await imageBridge.close().catch(() => undefined);
  registry.close();
  await agentServer.close().catch(() => undefined);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
