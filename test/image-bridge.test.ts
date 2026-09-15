import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import WebSocket from 'ws';
import { createActionRouter } from '../src/server/action-api.js';
import { DeviceRegistry } from '../src/server/device-registry.js';
import {
  ImageBridge,
  ImageBridgeError,
  TemporaryImageStore,
  validateImagePath,
} from '../src/server/image-bridge.js';
import { RELAY_CAPTURE_SCREENSHOT_TOOL } from '../src/shared/protocol.js';

test('validates image bridge paths without allowing traversal or system roots', () => {
  assert.equal(
    validateImagePath('/projects/example/error.png', ['/projects', '/workspace']),
    '/projects/example/error.png',
  );
  for (const value of [
    '/projects/example/../secret.png',
    '/etc/passwd.png',
    'https://example.com/image.png',
    'C:\\Users\\example\\image.png',
    '/projects/example/image.svg',
  ]) {
    assert.throws(() => validateImagePath(value, ['/projects', '/workspace']), ImageBridgeError);
  }
});

test('temporary image store survives restart and removes expired files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-image-store-test-'));
  const first = new TemporaryImageStore(directory, 60, 1024, 1_000);
  await first.start();
  await assert.rejects(first.store(Buffer.alloc(1025), 'image/png'), /exceeds/);
  const stored = await first.store(Buffer.from('image-data'), 'image/png');
  assert.match(stored.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await first.serve(stored.token, stored.extension))?.mimeType, 'image/png');
  await first.close();

  const filePath = path.join(directory, `${stored.token}.${stored.extension}`);
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(filePath, old, old);

  const restarted = new TemporaryImageStore(directory, 60, 1024, 1_000);
  await restarted.start();
  assert.equal(await restarted.serve(stored.token, stored.extension), null);
  await restarted.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('authenticated Action endpoints return temporary screenshot and device-image URLs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-image-api-test-'));
  const store = new TemporaryImageStore(directory, 500, 1024, 1_000);
  const registry = new DeviceRegistry('image-pc', 500, 4);
  const imageBytes = Buffer.from('test-image');
  const fake = fakeSocket((request) => {
    const result = {
      content: [{ type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' }],
    };
    registry.handleToolResult('image-pc', {
      type: 'tool_result',
      id: request.id,
      ok: true,
      result,
    });
  });
  registry.register({
    id: 'image-pc',
    name: 'Image PC',
    socket: fake.socket,
    tools: new Map([
      [RELAY_CAPTURE_SCREENSHOT_TOOL, {
        name: RELAY_CAPTURE_SCREENSHOT_TOOL,
        inputSchema: { type: 'object' },
      }],
      ['read_file', { name: 'read_file', inputSchema: { type: 'object' } }],
    ]),
    connectedAt: new Date(),
    lastSeenAt: new Date(),
  });
  const bridge = new ImageBridge(registry, store, {
    allowedDeviceIds: new Set(['image-pc']),
    allowedRoots: ['/projects'],
    maxBytes: 1024,
  });
  await bridge.start();

  const app = express();
  app.get('/i/:token.:extension', async (req, res) => {
    const image = await bridge.serve(req.params.token, req.params.extension);
    if (!image) {
      res.status(404).end();
      return;
    }
    res.type(image.mimeType).send(image.data);
  });
  app.use('/action', createActionRouter(registry, 'action-secret', false, '1mb', bridge, 'https://relay.example.test'));
  const server = http.createServer(app);
  await listen(server);
  t.after(async () => {
    registry.close();
    await bridge.close();
    await close(server);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer action-secret', 'content-type': 'application/json' };

  const unauthorized = await fetch(`${baseUrl}/action/capture_screenshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: 'image-pc' }),
  });
  assert.equal(unauthorized.status, 401);

  const notAllowlisted = await fetch(`${baseUrl}/action/capture_screenshot`, {
    method: 'POST', headers, body: JSON.stringify({ device_id: 'other-pc' }),
  });
  assert.equal(notAllowlisted.status, 403);

  const screenshot = await fetch(`${baseUrl}/action/capture_screenshot`, {
    method: 'POST', headers, body: JSON.stringify({ device_id: 'image-pc' }),
  });
  assert.equal(screenshot.status, 200);
  const screenshotBody = await screenshot.json() as Record<string, unknown>;
  assert.equal(screenshotBody.success, true);
  assert.match(String(screenshotBody.image_url), /^https:\/\/relay\.example\.test\/i\/[A-Za-z0-9_-]{43}\.png$/);
  assert.equal(screenshotBody.path, undefined);
  const screenshotPath = new URL(String(screenshotBody.image_url)).pathname;
  const screenshotImage = await fetch(`${baseUrl}${screenshotPath}`);
  assert.equal(screenshotImage.status, 200);
  assert.equal(screenshotImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await screenshotImage.arrayBuffer()), imageBytes);

  const upload = await fetch(`${baseUrl}/action/upload_device_image`, {
    method: 'POST', headers, body: JSON.stringify({ device_id: 'image-pc', path: '/projects/error.png' }),
  });
  assert.equal(upload.status, 200);
  const uploadBody = await upload.json() as Record<string, unknown>;
  assert.equal(uploadBody.success, true);

  const traversal = await fetch(`${baseUrl}/action/upload_device_image`, {
    method: 'POST', headers, body: JSON.stringify({ device_id: 'image-pc', path: '/projects/../etc/passwd.png' }),
  });
  assert.equal(traversal.status, 400);

  await new Promise((resolve) => setTimeout(resolve, 600));
  const expired = await fetch(`${baseUrl}${screenshotPath}`);
  assert.equal(expired.status, 404);
});

interface FakeRequest {
  id: string;
  name: string;
}

function fakeSocket(onSend: (request: FakeRequest) => void) {
  const socket = {
    readyState: WebSocket.OPEN,
    send(payload: string, callback?: (error?: Error) => void) {
      const request = JSON.parse(payload) as FakeRequest;
      onSend(request);
      callback?.();
    },
    close() {},
  } as unknown as WebSocket;
  return { socket };
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
