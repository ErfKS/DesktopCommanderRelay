import express from 'express';
import type { JsonObject, ToolDefinition } from '../shared/protocol.js';
import { bearerMiddleware } from './auth.js';
import { DeviceRegistry } from './device-registry.js';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BLOCKED_ACTION_TOOLS = new Set([
  'set_config_value',
  'start_process',
  'interact_with_process',
  'read_process_output',
  'force_terminate',
  'kill_process',
]);

function isActionToolAllowed(name: string): boolean {
  return !BLOCKED_ACTION_TOOLS.has(name);
}

function summarizeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
  };
}

export function createActionRouter(
  registry: DeviceRegistry,
  actionApiKey: string | undefined,
  allowInsecureLocal: boolean,
  httpBodyLimit: string,
) {
  const router = express.Router();

  router.use(bearerMiddleware(actionApiKey, allowInsecureLocal));

  router.get('/status', (_req, res) => {
    const selected = registry.getSelectedDevice();

    res.json({
      ok: true,
      selection_problem: registry.selectionProblem(),
      selected_device: selected
        ? {
            id: selected.id,
            name: selected.name,
            connected: true,
            tool_count: selected.tools.size,
          }
        : null,
      devices: registry.listDevices(),
    });
  });

  router.get('/tools', (req, res) => {
    const tools = registry.listMcpTools().filter((tool) =>
      isActionToolAllowed(tool.name),
    );

    const requestedName =
      typeof req.query.name === 'string'
        ? req.query.name.trim()
        : '';

    if (requestedName) {
      const tool = tools.find((item) => item.name === requestedName);

      if (!tool) {
        res.status(404).json({
          ok: false,
          error: `Tool '${requestedName}' was not found`,
        });
        return;
      }

      res.json({
        ok: true,
        tool,
      });
      return;
    }

    res.json({
      ok: true,
      count: tools.length,
      tools: tools.map(summarizeTool),
    });
  });

  router.post(
    '/tools/:name/call',
    express.json({
      limit: httpBodyLimit,
      type: ['application/json', 'application/*+json'],
    }),
    async (req, res) => {
      const name = req.params.name?.trim();

      if (!name || name.length > 200) {
        res.status(400).json({
          ok: false,
          error: 'Invalid tool name',
        });
        return;
      }

      if (!isActionToolAllowed(name)) {
        res.status(403).json({
          ok: false,
          error: `Tool '${name}' is not permitted through ChatGPT Actions`,
        });
        return;
      }

      let args: JsonObject = {};

      if (req.body !== undefined && req.body !== null) {
        if (!isJsonObject(req.body)) {
          res.status(400).json({
            ok: false,
            error: 'Request body must be a JSON object',
          });
          return;
        }

        if ('arguments' in req.body) {
          const candidate = req.body.arguments;

          if (!isJsonObject(candidate)) {
            res.status(400).json({
              ok: false,
              error: '"arguments" must be a JSON object',
            });
            return;
          }

          args = candidate;
        } else {
          args = req.body;
        }
      }

      try {
        const result = await registry.callTool(
          name,
          args,
          {
            transport: 'chatgpt-action',
          },
        );

        res.json({
          ok: true,
          tool: name,
          result,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        let status = 502;

        if (message.includes('not available')) {
          status = 404;
        } else if (
          message.includes('No target') ||
          message.includes('not connected') ||
          message.includes('No Desktop Commander agent') ||
          message.includes('Configured TARGET_DEVICE_ID') ||
          message.includes('Multiple agents')
        ) {
          status = 409;
        } else if (message.includes('timed out')) {
          status = 504;
        }

        res.status(status).json({
          ok: false,
          error: message,
        });
      }
    },
  );

  return router;
}
