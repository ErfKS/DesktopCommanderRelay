import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildDesktopCommanderEnvironment,
  resolveDesktopCommanderCommand,
} from '../src/agent/local-desktop-commander.js';

test('auto-detects the real sibling DesktopCommanderMCP build without an explicit entry', async () => {
  const previousEntry = process.env.DESKTOP_COMMANDER_ENTRY;
  const previousCommand = process.env.DESKTOP_COMMANDER_COMMAND;
  const previousArgs = process.env.DESKTOP_COMMANDER_ARGS_JSON;
  delete process.env.DESKTOP_COMMANDER_ENTRY;
  process.env.DESKTOP_COMMANDER_COMMAND = 'this-command-must-not-win';
  process.env.DESKTOP_COMMANDER_ARGS_JSON = '[]';
  try {
    const spec = await resolveDesktopCommanderCommand();
    const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const expected = path.resolve(relayRoot, '..', 'DesktopCommanderMCP', 'dist', 'index.js');
    assert.equal(spec.command, process.execPath);
    assert.equal(path.normalize(spec.args[0]!), path.normalize(expected));
  } finally {
    if (previousEntry === undefined) delete process.env.DESKTOP_COMMANDER_ENTRY;
    else process.env.DESKTOP_COMMANDER_ENTRY = previousEntry;
    if (previousCommand === undefined) delete process.env.DESKTOP_COMMANDER_COMMAND;
    else process.env.DESKTOP_COMMANDER_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.DESKTOP_COMMANDER_ARGS_JSON;
    else process.env.DESKTOP_COMMANDER_ARGS_JSON = previousArgs;
  }
});

test('does not inherit Relay secrets into the Desktop Commander child environment', () => {
  const env = buildDesktopCommanderEnvironment({
    PATH: 'safe-path',
    AGENT_TOKEN: 'agent-secret',
    MCP_API_KEY: 'mcp-secret',
    DESKTOP_COMMANDER_TEST_VALUE: 'not-forwarded',
    DESKTOP_COMMANDER_ENV_ALLOWLIST: '',
  });
  assert.equal(env.DC_REMOTE_DEVICE, 'true');
  assert.equal(env.AGENT_TOKEN, undefined);
  assert.equal(env.MCP_API_KEY, undefined);
  assert.equal(env.DESKTOP_COMMANDER_TEST_VALUE, undefined);
});

test('forwards only explicitly allowlisted additional environment names', () => {
  const env = buildDesktopCommanderEnvironment({
    DESKTOP_COMMANDER_TEST_VALUE: 'allowed',
    DESKTOP_COMMANDER_ENV_ALLOWLIST: 'DESKTOP_COMMANDER_TEST_VALUE,not a valid name',
  });
  assert.equal(env.DESKTOP_COMMANDER_TEST_VALUE, 'allowed');
  assert.equal(env['not a valid name'], undefined);
});
