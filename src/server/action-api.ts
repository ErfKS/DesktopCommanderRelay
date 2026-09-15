import express from 'express';
import type { JsonObject, ToolDefinition } from '../shared/protocol.js';
import { bearerMiddleware } from './auth.js';
import { DeviceRegistry } from './device-registry.js';
import { normalizeDeviceId } from '../shared/security.js';
import {
  createVisionBridgeFromEnv,
  VisionBridgeError,
} from './vision-bridge.js';
import {
  createImageBridgeFromEnv,
  ImageBridge,
  ImageBridgeError,
  imageUrlForRequest,
} from './image-bridge.js';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalDeviceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('Invalid device_id');
  }

  return normalizeDeviceId(value);
}

const ALWAYS_BLOCKED_ACTION_TOOLS = new Set([
  'set_config_value',
  'kill_process',
]);

const SANDBOX_ONLY_ACTION_TOOLS = new Set([
  'start_process',
  'interact_with_process',
  'read_process_output',
  'force_terminate',
]);

function parseSandboxDeviceIds(value: string | undefined): Set<string> {
  const deviceIds = new Set<string>();

  for (const raw of (value ?? '').split(',')) {
    const candidate = raw.trim();
    if (!candidate) continue;

    deviceIds.add(normalizeDeviceId(candidate));
  }

  return deviceIds;
}

function isActionToolAllowed(
  name: string,
  deviceId: string | undefined,
  sandboxDeviceIds: ReadonlySet<string>,
): boolean {
  if (ALWAYS_BLOCKED_ACTION_TOOLS.has(name)) {
    return false;
  }

  if (SANDBOX_ONLY_ACTION_TOOLS.has(name)) {
    return deviceId !== undefined && sandboxDeviceIds.has(deviceId);
  }

  return true;
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
  imageBridge: ImageBridge = createImageBridgeFromEnv(registry),
  publicBaseUrl?: string,
) {
  const router = express.Router();
  const sandboxDeviceIds = parseSandboxDeviceIds(
    process.env.ACTION_SANDBOX_DEVICE_IDS,
  );

  const visionBridge = createVisionBridgeFromEnv(registry);
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

  router.post(
    '/capture_screenshot',
    express.json({
      limit: httpBodyLimit,
      type: ['application/json', 'application/*+json'],
    }),
    async (req, res) => {
      if (!isJsonObject(req.body)) {
        res.status(400).json({ success: false, ok: false, error: 'Request body must be a JSON object' });
        return;
      }

      let deviceId: string | undefined;
      try {
        deviceId = parseOptionalDeviceId(req.body.device_id);
      } catch {
        res.status(400).json({ success: false, ok: false, error: 'Invalid device_id' });
        return;
      }
      if (!deviceId) {
        res.status(400).json({ success: false, ok: false, error: 'device_id is required' });
        return;
      }

      try {
        const image = await imageBridge.captureScreenshot(deviceId);
        res.json({
          success: true,
          ok: true,
          device_id: deviceId,
          image_url: imageUrlForRequest(req, image, publicBaseUrl),
          expires_at: image.expiresAt,
          bytes: image.bytes,
          mime_type: image.mimeType,
        });
      } catch (error) {
        sendImageBridgeError(res, error);
      }
    },
  );

  router.post(
    '/upload_device_image',
    express.json({
      limit: httpBodyLimit,
      type: ['application/json', 'application/*+json'],
    }),
    async (req, res) => {
      if (!isJsonObject(req.body)) {
        res.status(400).json({ success: false, ok: false, error: 'Request body must be a JSON object' });
        return;
      }

      let deviceId: string | undefined;
      try {
        deviceId = parseOptionalDeviceId(req.body.device_id);
      } catch {
        res.status(400).json({ success: false, ok: false, error: 'Invalid device_id' });
        return;
      }
      if (!deviceId) {
        res.status(400).json({ success: false, ok: false, error: 'device_id is required' });
        return;
      }
      if (typeof req.body.path !== 'string') {
        res.status(400).json({ success: false, ok: false, error: 'path must be a string' });
        return;
      }

      try {
        const image = await imageBridge.uploadDeviceImage(deviceId, req.body.path);
        res.json({
          success: true,
          ok: true,
          device_id: deviceId,
          image_url: imageUrlForRequest(req, image, publicBaseUrl),
          expires_at: image.expiresAt,
          bytes: image.bytes,
          mime_type: image.mimeType,
        });
      } catch (error) {
        sendImageBridgeError(res, error);
      }
    },
  );

  router.post(
    '/images/analyze',
    express.json({
      limit: httpBodyLimit,
      type: ['application/json', 'application/*+json'],
    }),
    async (req, res) => {
      if (!isJsonObject(req.body)) {
        res.status(400).json({
          ok: false,
          error: 'Request body must be a JSON object',
        });
        return;
      }

      let deviceId: string | undefined;

      try {
        deviceId = parseOptionalDeviceId(req.body.device_id);
      } catch {
        res.status(400).json({
          ok: false,
          error: 'Invalid device_id',
        });
        return;
      }

      if (!deviceId) {
        res.status(400).json({
          ok: false,
          error: 'device_id is required',
        });
        return;
      }

      if (typeof req.body.path !== 'string') {
        res.status(400).json({
          ok: false,
          error: 'path must be a string',
        });
        return;
      }

      if (
        req.body.prompt !== undefined &&
        typeof req.body.prompt !== 'string'
      ) {
        res.status(400).json({
          ok: false,
          error: 'prompt must be a string',
        });
        return;
      }

      if (
        req.body.detail !== undefined &&
        typeof req.body.detail !== 'string'
      ) {
        res.status(400).json({
          ok: false,
          error: 'detail must be a string',
        });
        return;
      }

      try {
        const result = await visionBridge.analyze({
          deviceId,
          path: req.body.path,
          prompt:
            typeof req.body.prompt === 'string'
              ? req.body.prompt
              : undefined,
          detail:
            typeof req.body.detail === 'string'
              ? req.body.detail
              : undefined,
        });

        res.json({
          ok: true,
          device_id: result.deviceId,
          path: result.path,
          mime_type: result.mimeType,
          bytes: result.bytes,
          model: result.model,
          detail: result.detail,
          analysis: result.analysis,
        });
      } catch (error) {
        if (error instanceof VisionBridgeError) {
          res.status(error.status).json({
            ok: false,
            error: error.message,
          });
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        let status = 502;

        if (message.includes('not available')) {
          status = 404;
        } else if (
          message.includes('not connected') ||
          message.includes('No Desktop Commander agent')
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
  router.get('/tools', (req, res) => {
    let deviceId: string | undefined;

    try {
      deviceId = parseOptionalDeviceId(req.query.device_id);
    } catch {
      res.status(400).json({
        ok: false,
        error: 'Invalid device_id',
      });
      return;
    }

    if (deviceId && !registry.getDevice(deviceId)) {
      res.status(404).json({
        ok: false,
        error: `Device '${deviceId}' is not connected`,
      });
      return;
    }

    const tools = registry.listMcpTools(deviceId).filter((tool) =>
      isActionToolAllowed(tool.name, deviceId, sandboxDeviceIds),
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
      console.error('[ACTION CALL ENTERED]', {
        method: req.method,
        path: req.path,
        params: req.params,
        body: req.body,
      });
      console.error(
          '[ACTION RAW BODY TYPE]',
          typeof req.body,
          Array.isArray(req.body)
      );

      const name = req.params.name?.trim();

      if (!name || name.length > 200) {
        res.status(400).json({
          ok: false,
          error: 'Invalid tool name',
        });
        return;
      }

      let deviceId: string | undefined;

      if (isJsonObject(req.body) && 'device_id' in req.body) {
        try {
          deviceId = parseOptionalDeviceId(req.body.device_id);
        } catch {
          res.status(400).json({
            ok: false,
            error: 'Invalid device_id',
          });
          return;
        }
      }

      if (!isActionToolAllowed(name, deviceId, sandboxDeviceIds)) {
        res.status(403).json({
          ok: false,
          error: `Tool '${name}' is not permitted through ChatGPT Actions`,
        });
        return;
      }

      console.error(
          '[action-debug] incoming body:',
          JSON.stringify(req.body, null, 2),
      );

      console.error(
          '[action-debug] tool:',
          name,
          'device:',
          deviceId,
      );

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
          args = { ...req.body };
          delete args.device_id;
        }
      }

      // Normalize common Desktop Commander argument aliases
      if (name === 'read_file' && !args.path && args.file_path) {
        args.path = args.file_path;
        delete args.file_path;
      }

      if (name === 'read_multiple_files' && !args.paths && args.file_paths) {
        args.paths = args.file_paths;
        delete args.file_paths;
      }

      try {
        const result = await registry.callTool(
          name,
          args,
          {
            transport: 'chatgpt-action',
          },
          deviceId,
        );

        res.json({
          ok: true,
          device_id: deviceId ?? registry.getSelectedDevice()?.id ?? null,
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

function sendImageBridgeError(
  res: import('express').Response,
  error: unknown,
): void {
  if (error instanceof ImageBridgeError) {
    res.status(error.status).json({ success: false, ok: false, error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  let status = 502;
  if (message.includes('not available')) status = 404;
  else if (message.includes('not connected') || message.includes('No Desktop Commander agent')) status = 409;
  else if (message.includes('timed out')) status = 504;
  res.status(status).json({ success: false, ok: false, error: message });
}
