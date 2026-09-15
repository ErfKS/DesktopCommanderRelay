import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type { Request } from 'express';
import type { JsonObject } from '../shared/protocol.js';
import { RELAY_CAPTURE_SCREENSHOT_TOOL } from '../shared/protocol.js';
import { normalizeDeviceId } from '../shared/security.js';
import { extractImagePayload, VisionBridgeError } from './vision-bridge.js';
import { DeviceRegistry } from './device-registry.js';

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STORED_FILE_PATTERN = /^([A-Za-z0-9_-]{43})\.(png|jpg|jpeg|webp|gif)$/;
const TEMPORARY_FILE_PATTERN = /^[A-Za-z0-9_-]{43}\.tmp-[a-f0-9]{16}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export interface StoredImage {
  token: string;
  extension: string;
  mimeType: string;
  bytes: number;
  expiresAt: string;
}

export interface ServedImage {
  data: Buffer;
  mimeType: string;
  expiresAt: string;
}

export class ImageBridgeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImageBridgeError';
  }
}

export class TemporaryImageStore {
  private readonly ready: Promise<void>;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly directory: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
  ) {
    this.ready = this.initialize();
  }

  async close(): Promise<void> {
    await this.ready;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  async start(): Promise<void> {
    await this.ready;
  }

  async store(data: Buffer, mimeType: string): Promise<StoredImage> {
    await this.ready;
    const normalizedMimeType = normalizeMimeType(mimeType);
    const extension = MIME_EXTENSIONS[normalizedMimeType];
    if (!extension) {
      throw new ImageBridgeError(415, `Unsupported image MIME type: ${mimeType}`);
    }
    if (data.byteLength === 0) {
      throw new ImageBridgeError(502, 'The device returned an empty image');
    }
    if (data.byteLength > this.maxBytes) {
      throw new ImageBridgeError(413, `Image exceeds the ${this.maxBytes}-byte Image Bridge limit`);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const filename = `${token}.${extension}`;
    const finalPath = nodePath.join(this.directory, filename);
    const temporaryPath = nodePath.join(this.directory, `${token}.tmp-${crypto.randomBytes(8).toString('hex')}`);
    await fs.writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' });
    try {
      await fs.rename(temporaryPath, finalPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      token,
      extension,
      mimeType: normalizedMimeType,
      bytes: data.byteLength,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
  }

  async serve(token: string, extension: string): Promise<ServedImage | null> {
    await this.ready;
    const normalizedExtension = extension.toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[normalizedExtension];
    if (!mimeType || !TOKEN_PATTERN.test(token)) return null;

    const filePath = nodePath.join(this.directory, `${token}.${normalizedExtension}`);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const expiresAtMs = stat.mtimeMs + this.ttlMs;
    if (expiresAtMs <= Date.now()) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      return null;
    }

    if (stat.size <= 0 || stat.size > this.maxBytes) return null;
    return {
      data: await fs.readFile(filePath),
      mimeType,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      const storedMatch = STORED_FILE_PATTERN.exec(entry.name);
      const temporaryMatch = TEMPORARY_FILE_PATTERN.test(entry.name);
      if ((!storedMatch && !temporaryMatch) || !entry.isFile()) continue;
      const filePath = nodePath.join(this.directory, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs + this.ttlMs <= now) {
          await fs.rm(filePath, { force: true });
          removed++;
        }
      } catch {
        // Another cleanup or request may have removed the file already.
      }
    }
    return removed;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.cleanupExpired();
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error) => {
        console.error('[relay] image bridge cleanup failed:', error instanceof Error ? error.message : String(error));
      });
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }
}

export interface ImageBridgeConfig {
  allowedDeviceIds: ReadonlySet<string>;
  allowedRoots: readonly string[];
  maxBytes: number;
}

export class ImageBridge {
  constructor(
    private readonly registry: DeviceRegistry,
    private readonly store: TemporaryImageStore,
    private readonly config: ImageBridgeConfig,
  ) {}

  async captureScreenshot(deviceIdInput: string): Promise<StoredImage> {
    const deviceId = this.authorizeDevice(deviceIdInput);
    const result = await this.registry.callTool(
      RELAY_CAPTURE_SCREENSHOT_TOOL,
      { max_bytes: this.config.maxBytes } satisfies JsonObject,
      { transport: 'chatgpt-action-image-bridge' },
      deviceId,
    );
    return this.storeImage(result);
  }

  async uploadDeviceImage(deviceIdInput: string, imagePath: string): Promise<StoredImage> {
    const deviceId = this.authorizeDevice(deviceIdInput);
    const safePath = validateImagePath(imagePath, this.config.allowedRoots);
    const result = await this.registry.callTool(
      'read_file',
      { path: safePath, isUrl: false } satisfies JsonObject,
      { transport: 'chatgpt-action-image-bridge' },
      deviceId,
    );
    return this.storeImage(result);
  }

  async serve(token: string, extension: string): Promise<ServedImage | null> {
    return this.store.serve(token, extension);
  }

  async start(): Promise<void> {
    await this.store.start();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private authorizeDevice(deviceIdInput: string): string {
    let deviceId: string;
    try {
      deviceId = normalizeDeviceId(deviceIdInput);
    } catch {
      throw new ImageBridgeError(400, 'Invalid device_id');
    }
    if (!this.config.allowedDeviceIds.has(deviceId)) {
      throw new ImageBridgeError(403, `Device '${deviceId}' is not permitted to use the Image Bridge`);
    }
    if (!this.registry.getDevice(deviceId)) {
      throw new ImageBridgeError(404, `Device '${deviceId}' is not connected`);
    }
    return deviceId;
  }

  private async storeImage(result: unknown): Promise<StoredImage> {
    try {
      const image = extractImagePayload(result, this.config.maxBytes);
      return await this.store.store(Buffer.from(image.data, 'base64'), image.mimeType);
    } catch (error) {
      if (error instanceof ImageBridgeError) throw error;
      if (error instanceof VisionBridgeError) {
        throw new ImageBridgeError(error.status, error.message);
      }
      throw error;
    }
  }
}

export function validateImagePath(value: string, allowedRoots: readonly string[]): string {
  const candidate = value.trim();
  if (!candidate) throw new ImageBridgeError(400, 'path is required');
  if (candidate.length > 4096) throw new ImageBridgeError(400, 'path is too long');
  if (candidate.includes('\0') || candidate.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    throw new ImageBridgeError(400, 'Only local absolute Linux paths are permitted');
  }
  if (!candidate.startsWith('/')) throw new ImageBridgeError(400, 'path must be an absolute local path');
  if (candidate.split('/').includes('..')) throw new ImageBridgeError(400, 'Parent-directory traversal is not permitted');

  const normalized = nodePath.posix.normalize(candidate);
  const isAllowed = allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  if (!isAllowed) throw new ImageBridgeError(403, 'Image access is limited to configured image roots');

  const extension = nodePath.posix.extname(normalized).toLowerCase().replace(/^\./, '');
  if (!IMAGE_MIME_TYPES[extension]) {
    throw new ImageBridgeError(415, 'Unsupported image extension. Allowed: png, jpg, jpeg, webp, gif');
  }
  return normalized;
}

export function createImageBridgeFromEnv(registry: DeviceRegistry): ImageBridge {
  const allowedDeviceIds = parseDeviceIds(process.env.ACTION_IMAGE_DEVICE_IDS);
  const allowedRoots = parseAllowedRoots(process.env.IMAGE_BRIDGE_ALLOWED_ROOTS);
  const maxBytes = envInteger('IMAGE_BRIDGE_MAX_BYTES', DEFAULT_MAX_BYTES, 1024, 50 * 1024 * 1024);
  const ttlMs = envInteger('IMAGE_BRIDGE_TTL_MS', DEFAULT_TTL_MS, 1_000, 7 * DEFAULT_TTL_MS);
  const cleanupIntervalMs = envInteger('IMAGE_BRIDGE_CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS, 1_000, DEFAULT_TTL_MS);
  const directory = nodePath.resolve(process.env.IMAGE_BRIDGE_STORAGE_DIR?.trim() || nodePath.join(process.cwd(), 'tmp', 'image-bridge'));
  const store = new TemporaryImageStore(directory, ttlMs, maxBytes, cleanupIntervalMs);
  return new ImageBridge(registry, store, { allowedDeviceIds, allowedRoots, maxBytes });
}

export function imageUrlForRequest(
  request: Request,
  image: StoredImage,
  publicBaseUrl?: string,
): string {
  const base = publicBaseUrl?.trim() || `${request.protocol}://${request.get('host')}`;
  return new URL(`/i/${image.token}.${image.extension}`, `${base.replace(/\/$/, '')}/`).toString();
}

function normalizeMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized || '';
}

function parseDeviceIds(value: string | undefined): Set<string> {
  const result = new Set<string>();
  for (const raw of (value ?? '').split(',')) {
    const candidate = raw.trim();
    if (!candidate) continue;
    result.add(normalizeDeviceId(candidate));
  }
  return result;
}

function parseAllowedRoots(value: string | undefined): string[] {
  const rawRoots = (value ?? '/projects,/workspace').split(',');
  const roots = rawRoots.map((raw) => {
    const rawCandidate = raw.trim();
    const candidate = nodePath.posix.normalize(rawCandidate);
    if (!rawCandidate.startsWith('/') || rawCandidate.split('/').includes('..') || !candidate.startsWith('/')) {
      throw new Error('IMAGE_BRIDGE_ALLOWED_ROOTS must contain absolute POSIX paths without parent traversal');
    }
    return candidate.replace(/\/$/, '') || '/';
  }).filter((root) => root !== '/');
  if (roots.length === 0) throw new Error('IMAGE_BRIDGE_ALLOWED_ROOTS must contain at least one non-root path');
  return [...new Set(roots)];
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
