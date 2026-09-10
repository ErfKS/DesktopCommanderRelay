import crypto from 'node:crypto';

export function timingSafeEqualText(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function parseBearerHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return null;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

export function normalizeDeviceId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized.length > 80) throw new Error('Invalid device id');
  return normalized;
}

export function isAllowedHostHeader(value: string | string[] | undefined, allowedHostnames: readonly string[]): boolean {
  if (Array.isArray(value) || !value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return allowedHostnames.some((allowed) => allowed.toLowerCase() === hostname);
  } catch {
    return false;
  }
}

export function isAllowedOriginHeader(value: string | string[] | undefined, allowedHostnames: readonly string[]): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return allowedHostnames.some((allowed) => allowed.toLowerCase() === hostname);
  } catch {
    return false;
  }
}
