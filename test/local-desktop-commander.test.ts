import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildDesktopCommanderEnvironment,
  resolveDesktopCommanderCommand,
} from '../src/agent/local-desktop-commander.js';

test('prefers an explicit Desktop Commander command over sibling auto-detection', async () => {
  const previousEntry = process.env.DESKTOP_COMMANDER_ENTRY;
  const previousCommand = process.env.DESKTOP_COMMANDER_COMMAND;
  const previousArgs = process.env.DESKTOP_COMMANDER_ARGS_JSON;

  delete process.env.DESKTOP_COMMANDER_ENTRY;
  process.env.DESKTOP_COMMANDER_COMMAND = 'custom-desktop-commander';
  process.env.DESKTOP_COMMANDER_ARGS_JSON = '["--sandbox"]';

  try {
    const spec = await resolveDesktopCommanderCommand();

    assert.equal(spec.command, 'custom-desktop-commander');
    assert.deepEqual(spec.args, ['--sandbox']);
  } finally {
    if (previousEntry === undefined) delete process.env.DESKTOP_COMMANDER_ENTRY;
    else process.env.DESKTOP_COMMANDER_ENTRY = previousEntry;

    if (previousCommand === undefined) delete process.env.DESKTOP_COMMANDER_COMMAND;
    else process.env.DESKTOP_COMMANDER_COMMAND = previousCommand;

    if (previousArgs === undefined) delete process.env.DESKTOP_COMMANDER_ARGS_JSON;
    else process.env.DESKTOP_COMMANDER_ARGS_JSON = previousArgs;
  }
});

test('auto-detects the sibling DesktopCommanderMCP build when no explicit command is configured', async (t) => {
  const relayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const expected = path.resolve(relayRoot, '..', 'DesktopCommanderMCP', 'dist', 'index.js');

  try {
    await fs.access(expected);
  } catch {
    t.skip('Sibling DesktopCommanderMCP checkout is not present in this deployment');
    return;
  }

  const previousEntry = process.env.DESKTOP_COMMANDER_ENTRY;
  const previousCommand = process.env.DESKTOP_COMMANDER_COMMAND;
  const previousArgs = process.env.DESKTOP_COMMANDER_ARGS_JSON;

  delete process.env.DESKTOP_COMMANDER_ENTRY;
  delete process.env.DESKTOP_COMMANDER_COMMAND;
  process.env.DESKTOP_COMMANDER_ARGS_JSON = '[]';

  try {
    const spec = await resolveDesktopCommanderCommand();

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
