import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { createOwnerPasswordHash } from '../src/server/oauth.js';

const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownerUsername = 'oauth-owner';
const ownerPassword = 'correct horse battery staple';
const issuerUrl = 'https://mcp.example.test';
const resourceUrl = `${issuerUrl}/mcp`;

test('OAuth discovery, PKCE, persistence, MCP authorization, and legacy authentication', { timeout: 90_000 }, async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-commander-oauth-'));
  const legacyKey = 'legacy-mcp-key';
  const server = startServer(port, dataDir, legacyKey);
  t.after(async () => {
    await stopProcess(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForOutput(server, 'HTTP listening');

  const baseUrl = `http://127.0.0.1:${port}`;
  const metadata = await getJson(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.deepEqual(metadata.resource, resourceUrl);
  assert.deepEqual(metadata.authorization_servers, [issuerUrl]);
  const authorizationServer = await getJson(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationServer.authorization_endpoint, `${issuerUrl}/oauth/authorize`);
  assert.deepEqual(authorizationServer.code_challenge_methods_supported, ['S256']);

  const anonymous = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /resource_metadata=/);

  const invalidRedirect = await postJson(`${baseUrl}/oauth/register`, {
    client_name: 'bad-client',
    redirect_uris: ['https://evil.example/callback'],
  });
  assert.equal(invalidRedirect.status, 400);
  assert.equal(invalidRedirect.body.error, 'invalid_redirect_uri');

  const registration = await postJson(`${baseUrl}/oauth/register`, {
    client_name: 'integration-test-client',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  assert.equal(registration.status, 201);
  const clientId = registration.body.client_id as string;

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = 'oauth-test-state';
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'mcp:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: resourceUrl,
  }).toString();
  const loginPage = await fetch(authorizeUrl);
  assert.equal(loginPage.status, 200);
  const cookie = cookieFrom(loginPage);
  const csrf = hiddenValue(await loginPage.text(), 'csrf');
  assert.ok(!loginPage.url.includes(ownerPassword));

  const login = await fetch(`${baseUrl}/oauth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, username: ownerUsername, password: ownerPassword }).toString(),
  });
  assert.equal(login.status, 302);
  const loginLocation = new URL(login.headers.get('location') ?? '');
  const consentPage = await fetch(`${baseUrl}${loginLocation.pathname}${loginLocation.search}`, { headers: { cookie } });
  assert.equal(consentPage.status, 200);
  const consentCsrf = hiddenValue(await consentPage.text(), 'csrf');

  const consent = await fetch(`${baseUrl}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: consentCsrf, decision: 'allow' }).toString(),
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location') ?? '');
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), issuerUrl);
  const code = callback.searchParams.get('code');
  assert.ok(code, callback.toString());

  const wrongResource = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: verifier,
    resource: `${issuerUrl}/wrong-resource`,
  });
  assert.equal(wrongResource.status, 400);
  assert.equal(wrongResource.body.error, 'invalid_target');

  const tokenResponse = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: verifier,
    resource: resourceUrl,
  });
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokenResponse.body));
  const accessToken = tokenResponse.body.access_token as string;
  assert.match(accessToken, /^at_/);
  assert.equal(tokenResponse.body.resource, resourceUrl);

  const wrongVerifier = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: `${verifier}wrong`,
    resource: resourceUrl,
  });
  assert.equal(wrongVerifier.status, 400);

  const replay = await postForm(`${baseUrl}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: verifier,
    resource: resourceUrl,
  });
  assert.equal(replay.status, 400);

  const stateFile = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  assert.ok(!stateFile.includes(ownerPassword));
  assert.ok(!stateFile.includes(accessToken));
  assert.ok(stateFile.includes(crypto.createHash('sha256').update(accessToken).digest('hex')));

  const oauthInitialize = await mcpRequest(baseUrl, accessToken, 'initialize');
  assert.equal(oauthInitialize.status, 200);
  const tools = await mcpRequest(baseUrl, accessToken, 'tools/list');
  assert.equal(tools.status, 200, JSON.stringify(tools.body));
  assert.ok(tools.body.result?.tools, JSON.stringify(tools.body));
  assert.deepEqual((tools.body.result.tools as Array<{ name: string }>).map((tool) => tool.name), ['relay_status', 'relay_list_devices']);
  const statusCall = await mcpRequest(baseUrl, accessToken, 'tools/call', { name: 'relay_status', arguments: {} });
  assert.equal(statusCall.status, 200);
  const forbiddenCall = await mcpRequest(baseUrl, accessToken, 'tools/call', { name: 'read_file', arguments: { path: 'secret.txt' } });
  assert.equal(forbiddenCall.status, 403);
  assert.match(forbiddenCall.headers.get('www-authenticate') ?? '', /insufficient_scope/);

  const legacyInitialize = await mcpRequest(baseUrl, legacyKey, 'initialize');
  assert.equal(legacyInitialize.status, 200);
  const actionWithOAuth = await fetch(`${baseUrl}/action/status`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(actionWithOAuth.status, 401);
  const malformed = await mcpRequest(baseUrl, 'at_wrong-issuer-audience', 'initialize');
  assert.equal(malformed.status, 401);

  await stopProcess(server);
  const restarted = startServer(port, dataDir, legacyKey);
  t.after(async () => stopProcess(restarted));
  await waitForOutput(restarted, 'HTTP listening');
  const restartInitialize = await mcpRequest(baseUrl, accessToken, 'initialize');
  assert.equal(restartInitialize.status, 200);
  const afterRestart = await mcpRequest(baseUrl, accessToken, 'tools/list');
  assert.equal(afterRestart.status, 200);

  const revoked = await postForm(`${baseUrl}/oauth/revoke`, { token: accessToken, token_type_hint: 'access_token' });
  assert.equal(revoked.status, 200);
  const afterRevoke = await mcpRequest(baseUrl, accessToken, 'initialize');
  assert.equal(afterRevoke.status, 401);
});

function startServer(port: number, dataDir: string, legacyKey: string): ChildProcess {
  return spawn(process.execPath, [path.join(relayRoot, 'dist/server/index.js')], {
    cwd: relayRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MCP_API_KEY: legacyKey,
      ACTION_API_KEY: 'action-api-key',
      AGENT_TOKEN: 'oauth-test-agent-token',
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      MCP_ALLOWED_ORIGINS: 'http://127.0.0.1',
      MCP_OAUTH_ENABLED: 'true',
      MCP_OAUTH_ISSUER_URL: issuerUrl,
      MCP_OAUTH_RESOURCE_URL: resourceUrl,
      MCP_OAUTH_DATA_DIR: dataDir,
      MCP_OAUTH_OWNER_USERNAME: ownerUsername,
      MCP_OAUTH_OWNER_PASSWORD_HASH: createOwnerPasswordHash(ownerPassword),
      MCP_OAUTH_SCOPES: 'mcp:read,mcp:write',
      MCP_OAUTH_DEFAULT_SCOPES: 'mcp:read,mcp:write',
      MCP_OAUTH_ALLOWED_TOOLS: 'relay_status,relay_list_devices',
      MCP_OAUTH_ALLOWED_DEVICE_IDS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function mcpRequest(baseUrl: string, token: string, method: string, params?: Record<string, unknown>, sessionId?: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: params ?? (method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } } : {}) }),
  });
  const text = await response.text();
  const jsonText = text.includes('data:') ? text.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() ?? '{}' : text;
  return {
    status: response.status,
    headers: response.headers,
    sessionId: response.headers.get('mcp-session-id'),
    body: JSON.parse(jsonText || '{}') as Record<string, any>,
  };
}

async function getJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url);
  return response.json() as Promise<Record<string, any>>;
}

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function postForm(url: string, body: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
}

function cookieFrom(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0];
}

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  assert.ok(match, `missing hidden field ${name}`);
  return match[1];
}

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

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.killed) return;
  process.kill('SIGTERM');
  await new Promise<void>((resolve) => process.once('exit', () => resolve()));
}
