import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { parseBearerHeader, timingSafeEqualText } from '../shared/security.js';

export function bearerMiddleware(expectedToken: string | undefined, allowInsecureLocal: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expectedToken) {
      if (allowInsecureLocal) return next();
      res.status(503).json({ error: 'MCP_API_KEY is not configured' });
      return;
    }
    const token = parseBearerHeader(req.headers.authorization);
    if (!token || !timingSafeEqualText(token, expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="desktop-commander-relay"');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

export function authorizeAgentUpgrade(
  req: IncomingMessage,
  expectedToken: string | undefined,
  allowInsecureLocal: boolean,
): boolean {
  if (!expectedToken) return allowInsecureLocal;
  const token = parseBearerHeader(req.headers.authorization);
  return !!token && timingSafeEqualText(token, expectedToken);
}
