import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedHostHeader,
  isAllowedOriginHeader,
  normalizeDeviceId,
  parseBearerHeader,
  timingSafeEqualText,
} from '../src/shared/security.js';

test('normalizes device ids', () => {
  assert.equal(normalizeDeviceId(' Home PC '), 'home-pc');
  assert.equal(normalizeDeviceId('pc_1.local'), 'pc_1.local');
});

test('parses bearer authorization', () => {
  assert.equal(parseBearerHeader('Bearer abc123'), 'abc123');
  assert.equal(parseBearerHeader('Basic abc123'), null);
});

test('constant-time token helper preserves equality semantics', () => {
  assert.equal(timingSafeEqualText('secret', 'secret'), true);
  assert.equal(timingSafeEqualText('secret', 'other'), false);
});

test('rejects unexpected Host and Origin values', () => {
  const allowed = ['relay.example.com', '127.0.0.1'];
  assert.equal(isAllowedHostHeader('relay.example.com:8787', allowed), true);
  assert.equal(isAllowedHostHeader('evil.example.com', allowed), false);
  assert.equal(isAllowedOriginHeader('https://relay.example.com', allowed), true);
  assert.equal(isAllowedOriginHeader('https://evil.example.com', allowed), false);
  assert.equal(isAllowedOriginHeader(undefined, allowed), true);
});
