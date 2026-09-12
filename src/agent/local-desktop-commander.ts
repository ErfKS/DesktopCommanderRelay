import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ToolDefinition } from '../shared/protocol.js';
import { sanitizeToolDefinition } from '../shared/protocol.js';

interface CommandSpec {
  command: string;
  args: string[];
  cwd?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class LocalDesktopCommander {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<void> | null = null;

  async ensureConnected(): Promise<void> {
    if (this.client && this.transport) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = null; });
    await this.connecting;
  }

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureConnected();
    try {
      const response = await this.client!.listTools();
      return response.tools
        .map(sanitizeToolDefinition)
        .filter((tool): tool is ToolDefinition => !!tool);
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, metadata: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureConnected();
    try {
      return await this.client!.callTool({
        name,
        arguments: args,
        _meta: { remote: true, relay: true, ...metadata },
      } as never);
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async connect(): Promise<void> {
    const spec = await resolveDesktopCommanderCommand();
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: buildDesktopCommanderEnvironment(),
      stderr: 'inherit',
    });
    const client = new Client({ name: 'desktop-commander-relay-agent', version: '0.1.0' }, { capabilities: {} });

    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = null;
        this.transport = null;
      }
    };
    transport.onerror = (error) => {
      console.error('[agent] local Desktop Commander transport error:', error.message);
    };

    try {
      await client.connect(transport);
    } catch (error) {
      try { await client.close(); } catch { /* best effort */ }
      try { await transport.close(); } catch { /* best effort */ }
      throw error;
    }
    this.client = client;
    this.transport = transport;
    console.error(`[agent] local Desktop Commander connected via executable: ${spec.command}`);
  }

  private async reset(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    try { await client?.close(); } catch { /* best effort */ }
    try { await transport?.close(); } catch { /* best effort */ }
  }
}

export function buildDesktopCommanderEnvironment(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    DC_REMOTE_DEVICE: 'true',
  };
  const allowlist = (sourceEnv.DESKTOP_COMMANDER_ENV_ALLOWLIST ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => ENV_NAME.test(name));
  for (const name of allowlist) {
    const value = sourceEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function resolveDesktopCommanderCommand(): Promise<CommandSpec> {
  const explicitEntry = process.env.DESKTOP_COMMANDER_ENTRY?.trim();
  if (explicitEntry) {
    const absolute = path.resolve(explicitEntry);
    await fs.access(absolute);
    return { command: process.execPath, args: [absolute], cwd: path.dirname(absolute) };
  }

  const explicitCommand = process.env.DESKTOP_COMMANDER_COMMAND?.trim();
  if (explicitCommand) {
    const rawArgs = process.env.DESKTOP_COMMANDER_ARGS_JSON?.trim() || '[]';
    let args: unknown;
    try { args = JSON.parse(rawArgs); } catch { throw new Error('DESKTOP_COMMANDER_ARGS_JSON must be a JSON array'); }
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw new Error('DESKTOP_COMMANDER_ARGS_JSON must be a JSON array of strings');
    }
    return { command: explicitCommand, args: args as string[] };
  }

  // Convenient for the user's two-source-folder workspace.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const siblingBuild = path.resolve(moduleDir, '../../../DesktopCommanderMCP/dist/index.js');
  try {
    await fs.access(siblingBuild);
    return { command: process.execPath, args: [siblingBuild], cwd: path.dirname(siblingBuild) };
  } catch { /* fall through */ }

  const rawArgs = process.env.DESKTOP_COMMANDER_ARGS_JSON?.trim() || '[]';
  let args: unknown;
  try { args = JSON.parse(rawArgs); } catch { throw new Error('DESKTOP_COMMANDER_ARGS_JSON must be a JSON array'); }
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new Error('DESKTOP_COMMANDER_ARGS_JSON must be a JSON array of strings');
  }

  return { command: 'desktop-commander', args: args as string[] };
}
