import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OAuth2Server from '@node-oauth/oauth2-server';
import express, { type Request, type Response } from 'express';
import { envBool, envInt, envOptional, envString, splitCsv } from '../shared/env.js';
import { parseBearerHeader, timingSafeEqualText } from '../shared/security.js';

const SESSION_COOKIE = 'dcr_oauth_session';
const STATE_VERSION = 1;
const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'];
const DEFAULT_ALLOWED_TOOLS = ['relay_status', 'relay_list_devices'];
const CHATGPT_STABLE_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CALLBACK_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

export interface OAuthConfig {
  issuerUrl: string;
  resourceUrl: string;
  dataDir: string;
  ownerUsername: string;
  ownerPasswordHash: string;
  scopes: string[];
  defaultScopes: string[];
  allowedTools: string[];
  allowedDeviceIds: string[];
  allowedRedirectUris: string[];
  accessTokenLifetimeSec: number;
  refreshTokenLifetimeSec: number;
  authorizationCodeLifetimeSec: number;
  sessionLifetimeSec: number;
}

interface ClientRecord {
  id: string;
  name?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
  createdAt: number;
}

interface AuthorizationCodeRecord {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  expiresAt: number;
  used: boolean;
}

interface TokenRecord {
  clientId: string;
  userId: string;
  scope: string[];
  resource: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  revoked: boolean;
}

interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
  authenticated: boolean;
  csrfHash: string;
  pending?: PendingAuthorization;
}

interface PendingAuthorization {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
}

interface OAuthState {
  version: number;
  clients: Record<string, ClientRecord>;
  authorizationCodes: Record<string, AuthorizationCodeRecord>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
  sessions: Record<string, SessionRecord>;
}

export interface McpOAuthContext {
  clientId: string;
  userId: string;
  scopes: ReadonlySet<string>;
  allowedTools: ReadonlySet<string>;
  allowedDeviceIds: ReadonlySet<string>;
  resourceMetadataUrl: string;
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseUrl(value: string, name: string, allowPath = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL without credentials, query, or fragment`);
  }
  if (!allowPath && url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`Invalid ${name}: issuer URLs must not include a path`);
  }
  url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return url;
}

function parseDuration(name: string, fallback: number, min: number): number {
  return envInt(name, fallback, min);
}

function parseConfiguredRedirects(): string[] {
  const configured = splitCsv(envOptional('MCP_OAUTH_ALLOWED_REDIRECT_URIS'));
  for (const redirectUri of configured) parseUrl(redirectUri, 'MCP_OAUTH_ALLOWED_REDIRECT_URIS', true);
  return configured;
}

function normalizeScopeList(value: string[] | undefined, name: string): string[] {
  const scopes = [...new Set((value ?? []).map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.some((scope) => !/^[A-Za-z0-9._:-]+$/.test(scope))) {
    throw new Error(`Invalid ${name}: scopes may contain letters, numbers, '.', '_', ':', or '-'`);
  }
  return scopes;
}

function normalizeDeviceList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((deviceId) => deviceId.trim().toLowerCase()).filter(Boolean))];
}

export function loadOAuthConfig(): OAuthConfig | undefined {
  if (!envBool('MCP_OAUTH_ENABLED', false)) return undefined;

  const issuerUrl = parseUrl(envString('MCP_OAUTH_ISSUER_URL'), 'MCP_OAUTH_ISSUER_URL').toString().replace(/\/$/, '');
  const resourceUrl = parseUrl(envString('MCP_OAUTH_RESOURCE_URL'), 'MCP_OAUTH_RESOURCE_URL', true).toString().replace(/\/$/, '');
  const scopes = normalizeScopeList(splitCsv(envOptional('MCP_OAUTH_SCOPES')), 'MCP_OAUTH_SCOPES');
  const effectiveScopes = scopes.length > 0 ? scopes : DEFAULT_SCOPES;
  const defaultScopes = normalizeScopeList(
    splitCsv(envOptional('MCP_OAUTH_DEFAULT_SCOPES')).length > 0
      ? splitCsv(envOptional('MCP_OAUTH_DEFAULT_SCOPES'))
      : effectiveScopes,
    'MCP_OAUTH_DEFAULT_SCOPES',
  );
  if (defaultScopes.some((scope) => !effectiveScopes.includes(scope))) {
    throw new Error('MCP_OAUTH_DEFAULT_SCOPES must be a subset of MCP_OAUTH_SCOPES');
  }

  const dataDir = path.resolve(envString('MCP_OAUTH_DATA_DIR', './data/oauth'));
  const ownerUsername = envString('MCP_OAUTH_OWNER_USERNAME');
  const ownerPasswordHash = envString('MCP_OAUTH_OWNER_PASSWORD_HASH');
  if (ownerUsername.length > 128 || ownerPasswordHash.length > 512) {
    throw new Error('OAuth owner credentials are too long');
  }

  return {
    issuerUrl,
    resourceUrl,
    dataDir,
    ownerUsername,
    ownerPasswordHash,
    scopes: effectiveScopes,
    defaultScopes,
    allowedTools: splitCsv(envOptional('MCP_OAUTH_ALLOWED_TOOLS')).length > 0
      ? splitCsv(envOptional('MCP_OAUTH_ALLOWED_TOOLS'))
      : DEFAULT_ALLOWED_TOOLS,
    allowedDeviceIds: normalizeDeviceList(splitCsv(envOptional('MCP_OAUTH_ALLOWED_DEVICE_IDS'))),
    allowedRedirectUris: parseConfiguredRedirects(),
    accessTokenLifetimeSec: parseDuration('MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SEC', 3600, 60),
    refreshTokenLifetimeSec: parseDuration('MCP_OAUTH_REFRESH_TOKEN_LIFETIME_SEC', 1_209_600, 300),
    authorizationCodeLifetimeSec: parseDuration('MCP_OAUTH_AUTHORIZATION_CODE_LIFETIME_SEC', 300, 30),
    sessionLifetimeSec: parseDuration('MCP_OAUTH_SESSION_LIFETIME_SEC', 1800, 60),
  };
}

export function createOwnerPasswordHash(password: string): string {
  if (password.length < 12) throw new Error('OAuth owner password must be at least 12 characters');
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('base64url')}`;
}

function verifyOwnerPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isInteger) || n < 16_384 || n > 262_144 || r < 1 || r > 32 || p < 1 || p > 8) return false;
  const salt = parts[4];
  const encodedHash = parts[5];
  if (!salt || !encodedHash) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
    const expected = Buffer.from(encodedHash, 'base64url');
    return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    throw new Error(`Unable to read OAuth state file: ${filePath}`);
  }
}

function parseSingle(value: unknown): string | undefined {
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function parseScopes(value: unknown): string[] {
  return [...new Set((parseSingle(value) ?? '').split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function sendOAuthError(res: Response, status: number, error: string, description: string): void {
  setNoStore(res);
  res.status(status).json({ error, error_description: description });
}

export class OAuthService {
  readonly config: OAuthConfig;
  readonly oauth: OAuth2Server;
  readonly resourceMetadataUrl: string;
  private readonly statePath: string;
  private state: OAuthState;
  private readonly rate = new Map<string, { startedAt: number; count: number }>();

  constructor(config: OAuthConfig) {
    this.config = config;
    this.resourceMetadataUrl = `${config.issuerUrl}/.well-known/oauth-protected-resource`;
    this.statePath = path.join(config.dataDir, 'state.json');
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(config.dataDir, 0o700); } catch { /* Windows has no POSIX mode */ }
    this.state = readJson<OAuthState>(this.statePath, {
      version: STATE_VERSION,
      clients: {},
      authorizationCodes: {},
      accessTokens: {},
      refreshTokens: {},
      sessions: {},
    });
    if (this.state.version !== STATE_VERSION) throw new Error('Unsupported OAuth state version');
    this.cleanupExpired();

    const model: OAuth2Server.AuthorizationCodeModel & OAuth2Server.RefreshTokenModel = {
      getClient: async (clientId, clientSecret) => this.getClient(clientId, clientSecret),
      saveToken: async (token, client, user) => this.saveToken(token, client, user),
      getAccessToken: async (accessToken) => this.getAccessToken(accessToken),
      verifyScope: async (token, scope) => (scope ?? []).every((required) => token.scope?.includes(required)),
      generateAccessToken: async () => randomToken('at'),
      generateRefreshToken: async () => randomToken('rt'),
      saveAuthorizationCode: async (code, client, user) => this.saveAuthorizationCode(code, client, user),
      getAuthorizationCode: async (code) => this.getAuthorizationCode(code),
      revokeAuthorizationCode: async (code) => this.revokeAuthorizationCode(code),
      getRefreshToken: async (refreshToken) => this.getRefreshToken(refreshToken),
      revokeToken: async (token) => this.revokeToken(token),
      validateScope: async (_user, _client, scope) => this.validateScope(scope),
      validateRedirectUri: async (redirectUri, client) => this.validateRedirectUri(redirectUri, client),
    };

    this.oauth = new OAuth2Server({
      model,
      authorizationCodeLifetime: config.authorizationCodeLifetimeSec,
      accessTokenLifetime: config.accessTokenLifetimeSec,
      refreshTokenLifetime: config.refreshTokenLifetimeSec,
      requirePKCE: true,
      requireClientAuthentication: { authorization_code: false, refresh_token: false },
      alwaysIssueNewRefreshToken: true,
      allowExtendedTokenAttributes: false,
    });
  }

  metadata(): Record<string, unknown> {
    return {
      resource: this.config.resourceUrl,
      authorization_servers: [this.config.issuerUrl],
      scopes_supported: this.config.scopes,
      bearer_methods_supported: ['header'],
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.config.issuerUrl,
      authorization_endpoint: `${this.config.issuerUrl}/oauth/authorize`,
      token_endpoint: `${this.config.issuerUrl}/oauth/token`,
      registration_endpoint: `${this.config.issuerUrl}/oauth/register`,
      revocation_endpoint: `${this.config.issuerUrl}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: this.config.scopes,
      client_id_metadata_document_supported: false,
      authorization_response_iss_parameter_supported: true,
    };
  }

  isToolAllowed(name: string): boolean {
    return this.config.allowedTools.includes('*') || this.config.allowedTools.includes(name);
  }

  isDeviceAllowed(deviceId: string): boolean {
    return this.config.allowedDeviceIds.includes('*') || this.config.allowedDeviceIds.includes(deviceId.toLowerCase());
  }

  contextFromToken(token: OAuth2Server.Token): McpOAuthContext {
    return {
      clientId: token.client.id,
      userId: token.user.id,
      scopes: new Set(token.scope ?? []),
      allowedTools: new Set(this.config.allowedTools),
      allowedDeviceIds: new Set(this.config.allowedDeviceIds),
      resourceMetadataUrl: this.resourceMetadataUrl,
    };
  }

  async authenticateRequest(req: Request, res: Response, next: (error?: unknown) => void): Promise<void> {
    const token = parseBearerHeader(req.headers.authorization);
    if (!token) {
      this.challenge(res, 401, 'invalid_token', 'OAuth access token required');
      return;
    }
    try {
      const request = new OAuth2Server.Request({
        method: req.method,
        query: req.query as Record<string, unknown>,
        headers: req.headers as Record<string, unknown>,
        body: req.body,
      });
      const response = new OAuth2Server.Response();
      const accessToken = await this.oauth.authenticate(request, response, {
        scope: [],
        allowBearerTokensInQueryString: false,
        addAcceptedScopesHeader: false,
        addAuthorizedScopesHeader: false,
      });
      res.locals.mcpOAuth = this.contextFromToken(accessToken);
      next();
    } catch {
      this.challenge(res, 401, 'invalid_token', 'Invalid or expired OAuth access token');
    }
  }

  requireScope(req: Request, res: Response, scope: string): boolean {
    const context = res.locals.mcpOAuth as McpOAuthContext | undefined;
    if (!context || context.scopes.has(scope)) return true;
    this.challenge(res, 403, 'insufficient_scope', `OAuth scope required: ${scope}`, scope);
    return false;
  }

  challenge(res: Response, status: number, error: string, description: string, scope?: string): void {
    const params = [
      `error="${error}"`,
      ...(scope ? [`scope="${scope}"`] : []),
      `resource_metadata="${this.resourceMetadataUrl}"`,
      `error_description="${description.replace(/"/g, '')}"`,
    ];
    res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
    res.status(status).json({ error: status === 403 ? 'insufficient_scope' : 'Unauthorized' });
  }

  router(): express.Router {
    const router = express.Router();
    router.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(this.metadata()));
    router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(this.metadata()));
    router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(this.authorizationServerMetadata()));
    router.get('/.well-known/openid-configuration', (_req, res) => res.json(this.authorizationServerMetadata()));

    router.post('/oauth/register', express.json({ limit: '32kb' }), (req, res) => {
      if (!this.allowRate(req, res, 20, 300_000)) return;
      const body = req.body as Record<string, unknown>;
      const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
      if (redirectUris.length === 0 || redirectUris.length > 8 || redirectUris.some((value) => typeof value !== 'string')) {
        sendOAuthError(res, 400, 'invalid_client_metadata', 'redirect_uris must contain one to eight URLs');
        return;
      }
      const redirects = redirectUris as string[];
      if (!redirects.every((uri) => this.isAllowedRedirectUri(uri))) {
        sendOAuthError(res, 400, 'invalid_redirect_uri', 'The requested redirect URI is not allowed');
        return;
      }
      const grantTypes = Array.isArray(body?.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
      const responseTypes = Array.isArray(body?.response_types) ? body.response_types : ['code'];
      if (!grantTypes.every((value) => value === 'authorization_code' || value === 'refresh_token') || !grantTypes.includes('authorization_code')) {
        sendOAuthError(res, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
        return;
      }
      if (!responseTypes.every((value) => value === 'code')) {
        sendOAuthError(res, 400, 'invalid_client_metadata', 'Only the code response type is supported');
        return;
      }
      if (body?.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
        sendOAuthError(res, 400, 'invalid_client_metadata', 'Only public clients using token_endpoint_auth_method=none are supported');
        return;
      }

      const client: ClientRecord = {
        id: randomToken('client'),
        name: typeof body?.client_name === 'string' ? body.client_name.slice(0, 200) : undefined,
        redirectUris: redirects,
        grantTypes: grantTypes as string[],
        responseTypes: responseTypes as string[],
        tokenEndpointAuthMethod: 'none',
        createdAt: Date.now(),
      };
      this.state.clients[client.id] = client;
      this.persist();
      setNoStore(res);
      res.status(201).json({
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      });
    });

    router.get('/oauth/authorize', (req, res) => this.authorizeGet(req, res));
    router.post('/oauth/login', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => this.loginPost(req, res));
    router.get('/oauth/consent', (req, res) => this.consentGet(req, res));
    router.post('/oauth/consent', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => this.consentPost(req, res));

    router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => this.tokenPost(req, res));
    router.post('/oauth/revoke', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => this.revokePost(req, res));
    return router;
  }

  private async tokenPost(req: Request, res: Response): Promise<void> {
    if (!this.allowRate(req, res, 60, 60_000)) return;
    if (parseSingle(req.body?.resource) !== this.config.resourceUrl) {
      sendOAuthError(res, 400, 'invalid_target', 'The resource parameter must identify this MCP server');
      return;
    }
    try {
      const request = new OAuth2Server.Request({
        method: req.method,
        query: req.query as Record<string, unknown>,
        headers: req.headers as Record<string, unknown>,
        body: req.body,
      });
      const response = new OAuth2Server.Response();
      const token = await this.oauth.token(request, response, {
        accessTokenLifetime: this.config.accessTokenLifetimeSec,
        refreshTokenLifetime: this.config.refreshTokenLifetimeSec,
        requireClientAuthentication: { authorization_code: false, refresh_token: false },
        alwaysIssueNewRefreshToken: true,
      });
      setNoStore(res);
      res.status(response.status ?? 200).set(response.headers ?? {}).json({
        ...(response.body ?? {}),
        token_type: 'Bearer',
        resource: this.config.resourceUrl,
        scope: token.scope?.join(' '),
      });
    } catch (error) {
      const oauthError = error as { code?: number; name?: string; message?: string };
      sendOAuthError(res, oauthError.code === 401 ? 401 : 400, oauthError.name ?? 'invalid_grant', oauthError.message ?? 'OAuth token request failed');
    }
  }

  private async authorizeGet(req: Request, res: Response): Promise<void> {
    if (!this.allowRate(req, res, 30, 300_000)) return;
    const requestId = parseSingle(req.query.request_id);
    const session = this.session(req, res);
    if (requestId) {
      if (!session.pending || session.pending.id !== requestId) {
        sendOAuthError(res, 400, 'invalid_request', 'The authorization request has expired');
        return;
      }
      if (!session.authenticated) {
        this.renderLogin(res, session.pending.id, session.csrfHash);
        return;
      }
      this.renderConsent(res, session.pending, session.csrfHash);
      return;
    }

    const clientId = parseSingle(req.query.client_id);
    const redirectUri = parseSingle(req.query.redirect_uri);
    const responseType = parseSingle(req.query.response_type);
    const state = parseSingle(req.query.state);
    const codeChallenge = parseSingle(req.query.code_challenge);
    const codeChallengeMethod = parseSingle(req.query.code_challenge_method);
    const resource = parseSingle(req.query.resource);
    const client = clientId ? this.state.clients[clientId] : undefined;
    if (typeof clientId !== 'string' || typeof redirectUri !== 'string') {
      sendOAuthError(res, 400, 'invalid_request', 'The client or redirect URI is not valid');
      return;
    }
    if (!client || !redirectUri || !this.isAllowedRedirectUri(redirectUri) || !client.redirectUris.includes(redirectUri)) {
      sendOAuthError(res, 400, 'invalid_request', 'The client or redirect URI is not valid');
      return;
    }
    const verifiedClientId = clientId;
    const verifiedRedirectUri = redirectUri;
    if (responseType !== 'code' || !state || !codeChallenge || codeChallengeMethod !== 'S256') {
      this.redirectError(res, redirectUri, state, 'invalid_request', 'Authorization code flow with PKCE S256 and state is required');
      return;
    }
    if (resource !== this.config.resourceUrl) {
      this.redirectError(res, redirectUri, state, 'invalid_target', 'The resource parameter must identify this MCP server');
      return;
    }
    const requestedScopes = parseScopes(req.query.scope);
    const scope = requestedScopes.length > 0 ? requestedScopes : this.config.defaultScopes;
    if (scope.some((item) => !this.config.scopes.includes(item))) {
      this.redirectError(res, redirectUri, state, 'invalid_scope', 'The requested scope is not available');
      return;
    }
    const pending: PendingAuthorization = {
      id: randomToken('req'),
      clientId: verifiedClientId,
      redirectUri: verifiedRedirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
      resource,
    };
    session.pending = pending;
    this.persist();
    if (!session.authenticated) {
      this.renderLogin(res, pending.id, session.csrfHash);
      return;
    }
    this.renderConsent(res, pending, session.csrfHash);
  }

  private loginPost(req: Request, res: Response): void {
    if (!this.allowRate(req, res, 10, 300_000)) return;
    const session = this.session(req, res);
    const csrf = parseSingle(req.body?.csrf);
    if (!csrf || !timingSafeEqualText(csrf, session.csrfHash)) {
      sendOAuthError(res, 400, 'invalid_request', 'Invalid login form');
      return;
    }
    const username = parseSingle(req.body?.username) ?? '';
    const password = parseSingle(req.body?.password) ?? '';
    if (!timingSafeEqualText(username, this.config.ownerUsername) || !verifyOwnerPassword(password, this.config.ownerPasswordHash)) {
      this.renderLogin(res, session.pending?.id ?? '', session.csrfHash, 'Invalid owner credentials');
      return;
    }
    session.authenticated = true;
    session.lastSeenAt = Date.now();
    this.persist();
    if (!session.pending) {
      res.redirect(`${this.config.issuerUrl}/oauth/authorize`);
      return;
    }
    res.redirect(`${this.config.issuerUrl}/oauth/authorize?request_id=${encodeURIComponent(session.pending.id)}`);
  }

  private consentGet(req: Request, res: Response): void {
    const session = this.session(req, res);
    if (!session.pending || !session.authenticated) {
      sendOAuthError(res, 400, 'invalid_request', 'The authorization request has expired');
      return;
    }
    this.renderConsent(res, session.pending, session.csrfHash);
  }

  private async consentPost(req: Request, res: Response): Promise<void> {
    const session = this.session(req, res);
    const pending = session.pending;
    const csrf = parseSingle(req.body?.csrf);
    if (!pending || !session.authenticated || !csrf || !timingSafeEqualText(csrf, session.csrfHash)) {
      sendOAuthError(res, 400, 'invalid_request', 'Invalid consent form');
      return;
    }
    if (parseSingle(req.body?.decision) !== 'allow') {
      session.pending = undefined;
      this.persist();
      this.redirectError(res, pending.redirectUri, pending.state, 'access_denied', 'The owner denied access');
      return;
    }

    const request = new OAuth2Server.Request({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        scope: pending.scope.join(' '),
        state: pending.state,
        code_challenge: pending.codeChallenge,
        code_challenge_method: pending.codeChallengeMethod,
        allowed: 'true',
      },
      headers: { host: new URL(this.config.issuerUrl).host },
    });
    const response = new OAuth2Server.Response();
    try {
      await this.oauth.authorize(request, response, {
        requirePKCE: true,
        allowEmptyState: false,
        authorizationCodeLifetime: this.config.authorizationCodeLifetimeSec,
        authenticateHandler: { handle: () => ({ id: this.config.ownerUsername }) },
      });
      session.pending = undefined;
      this.persist();
      const location = response.headers?.location;
      if (!location) {
        sendOAuthError(res, 500, 'server_error', 'Authorization response was not created');
        return;
      }
      res.redirect(this.addIssuer(location));
    } catch {
      session.pending = undefined;
      this.persist();
      this.redirectError(res, pending.redirectUri, pending.state, 'access_denied', 'The authorization request could not be completed');
    }
  }

  private revokePost(req: Request, res: Response): void {
    const token = parseSingle(req.body?.token);
    if (token) {
      const key = hashToken(token);
      const record = this.state.accessTokens[key] ?? this.state.refreshTokens[key];
      if (record) {
        record.revoked = true;
        this.persist();
      }
    }
    setNoStore(res);
    res.status(200).end();
  }

  private getClient(clientId: string, clientSecret?: string): OAuth2Server.Client | undefined {
    if (clientSecret !== undefined && clientSecret !== null) return undefined;
    const client = this.state.clients[clientId];
    if (!client) return undefined;
    return {
      id: client.id,
      redirectUris: client.redirectUris,
      grants: client.grantTypes,
      responseTypes: client.responseTypes,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    };
  }

  private saveAuthorizationCode(
    code: Pick<OAuth2Server.AuthorizationCode, 'authorizationCode' | 'expiresAt' | 'redirectUri' | 'scope' | 'codeChallenge' | 'codeChallengeMethod'>,
    client: OAuth2Server.Client,
    user: OAuth2Server.User,
  ): OAuth2Server.AuthorizationCode {
    const record: AuthorizationCodeRecord = {
      clientId: client.id,
      userId: user.id,
      redirectUri: code.redirectUri,
      scope: code.scope ?? [],
      codeChallenge: code.codeChallenge ?? '',
      codeChallengeMethod: 'S256',
      expiresAt: code.expiresAt.getTime(),
      used: false,
    };
    this.state.authorizationCodes[hashToken(code.authorizationCode)] = record;
    this.persist();
    return { ...code, client, user };
  }

  private getAuthorizationCode(value: string): OAuth2Server.AuthorizationCode | undefined {
    const record = this.state.authorizationCodes[hashToken(value)];
    if (!record || record.used || record.expiresAt <= Date.now()) return undefined;
    const client = this.getClient(record.clientId);
    if (!client) return undefined;
    return {
      authorizationCode: value,
      expiresAt: new Date(record.expiresAt),
      redirectUri: record.redirectUri,
      scope: record.scope,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      client,
      user: { id: record.userId },
    };
  }

  private revokeAuthorizationCode(code: OAuth2Server.AuthorizationCode): boolean {
    const record = this.state.authorizationCodes[hashToken(code.authorizationCode)];
    if (!record || record.used) return false;
    record.used = true;
    this.persist();
    return true;
  }

  private saveToken(
    token: Omit<OAuth2Server.Token, 'client' | 'user'>,
    client: OAuth2Server.Client,
    user: OAuth2Server.User,
  ): OAuth2Server.Token {
    const record: TokenRecord = {
      clientId: client.id,
      userId: user.id,
      scope: token.scope ?? [],
      resource: this.config.resourceUrl,
      accessTokenExpiresAt: token.accessTokenExpiresAt?.getTime() ?? Date.now(),
      refreshTokenExpiresAt: token.refreshTokenExpiresAt?.getTime(),
      revoked: false,
    };
    this.state.accessTokens[hashToken(token.accessToken)] = record;
    if (token.refreshToken) this.state.refreshTokens[hashToken(token.refreshToken)] = record;
    this.persist();
    return { accessToken: token.accessToken, ...token, client, user };
  }

  private getAccessToken(value: string): OAuth2Server.Token | undefined {
    const record = this.state.accessTokens[hashToken(value)];
    if (!record || record.revoked || record.resource !== this.config.resourceUrl || record.accessTokenExpiresAt <= Date.now()) return undefined;
    const client = this.getClient(record.clientId);
    if (!client) return undefined;
    return {
      accessToken: value,
      accessTokenExpiresAt: new Date(record.accessTokenExpiresAt),
      scope: record.scope,
      client,
      user: { id: record.userId },
    };
  }

  private getRefreshToken(value: string): OAuth2Server.RefreshToken | undefined {
    const record = this.state.refreshTokens[hashToken(value)];
    if (!record || record.revoked || !record.refreshTokenExpiresAt || record.refreshTokenExpiresAt <= Date.now()) return undefined;
    const client = this.getClient(record.clientId);
    if (!client) return undefined;
    return {
      refreshToken: value,
      refreshTokenExpiresAt: new Date(record.refreshTokenExpiresAt),
      scope: record.scope,
      client,
      user: { id: record.userId },
    };
  }

  private revokeToken(token: OAuth2Server.RefreshToken): boolean {
    const record = this.state.refreshTokens[hashToken(token.refreshToken)];
    if (!record || record.revoked) return false;
    record.revoked = true;
    this.persist();
    return true;
  }

  private validateScope(scope: string[] | undefined): string[] | undefined {
    const requested = scope && scope.length > 0 ? scope : this.config.defaultScopes;
    return requested.every((item) => this.config.scopes.includes(item)) ? requested : undefined;
  }

  private validateRedirectUri(redirectUri: string, client: OAuth2Server.Client): boolean {
    return this.isAllowedRedirectUri(redirectUri) && client.redirectUris?.includes(redirectUri) === true;
  }

  private isAllowedRedirectUri(uri: string): boolean {
    if (this.config.allowedRedirectUris.length > 0) return this.config.allowedRedirectUris.includes(uri);
    return uri === CHATGPT_STABLE_REDIRECT || CHATGPT_CALLBACK_REDIRECT.test(uri);
  }

  private addIssuer(location: string): string {
    const url = new URL(location);
    url.searchParams.set('iss', this.config.issuerUrl);
    return url.toString();
  }

  private redirectError(res: Response, redirectUri: string, state: string | undefined, error: string, description: string): void {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    url.searchParams.set('iss', this.config.issuerUrl);
    res.redirect(url.toString());
  }

  private session(req: Request, res: Response): SessionRecord {
    this.cleanupExpired();
    const cookies = (req.headers.cookie ?? '').split(';').map((part) => part.trim());
    const raw = cookies.find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    const key = raw ? hashToken(raw) : '';
    let session = key ? this.state.sessions[key] : undefined;
    if (!session) {
      const sessionId = randomToken('session');
      session = {
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        authenticated: false,
        csrfHash: hashToken(randomToken('csrf')),
      };
      this.state.sessions[hashToken(sessionId)] = session;
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${this.config.sessionLifetimeSec}`);
      this.persist();
    } else {
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  private renderLogin(res: Response, requestId: string, csrfHash: string, error?: string): void {
    setNoStore(res);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Desktop Commander Relay sign in</title><h1>Sign in</h1>${error ? `<p>${escapeHtml(error)}</p>` : ''}<form method="post" action="/oauth/login"><input type="hidden" name="csrf" value="${escapeHtml(csrfHash)}"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><label>Username <input name="username" autocomplete="username" required></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required></label><br><button type="submit">Continue</button></form>`);
  }

  private renderConsent(res: Response, pending: PendingAuthorization, csrfHash: string): void {
    setNoStore(res);
    const scopes = pending.scope.map((scope) => `<li>${escapeHtml(scope)}</li>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Desktop Commander Relay authorization</title><h1>Authorize access</h1><p>Desktop Commander Relay is requesting access to the MCP resource.</p><ul>${scopes}</ul><form method="post" action="/oauth/consent"><input type="hidden" name="csrf" value="${escapeHtml(csrfHash)}"><button name="decision" value="allow" type="submit">Allow</button> <button name="decision" value="deny" type="submit">Deny</button></form>`);
  }

  private allowRate(req: Request, res: Response, limit: number, windowMs: number): boolean {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const current = this.rate.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.rate.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    if (current.count <= limit) return true;
    res.setHeader('Retry-After', Math.ceil((windowMs - (now - current.startedAt)) / 1000));
    sendOAuthError(res, 429, 'temporarily_unavailable', 'Too many OAuth requests');
    return false;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, code] of Object.entries(this.state.authorizationCodes)) {
      if (code.expiresAt <= now || code.used) { delete this.state.authorizationCodes[key]; changed = true; }
    }
    for (const [key, token] of Object.entries(this.state.accessTokens)) {
      if (token.accessTokenExpiresAt <= now || token.revoked) { delete this.state.accessTokens[key]; changed = true; }
    }
    for (const [key, token] of Object.entries(this.state.refreshTokens)) {
      if (token.refreshTokenExpiresAt !== undefined && (token.refreshTokenExpiresAt <= now || token.revoked)) { delete this.state.refreshTokens[key]; changed = true; }
    }
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (session.lastSeenAt + this.config.sessionLifetimeSec * 1000 <= now) { delete this.state.sessions[key]; changed = true; }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporaryPath, 0o600); } catch { /* Windows has no POSIX mode */ }
    fs.renameSync(temporaryPath, this.statePath);
    try { fs.chmodSync(this.statePath, 0o600); } catch { /* Windows has no POSIX mode */ }
  }
}
