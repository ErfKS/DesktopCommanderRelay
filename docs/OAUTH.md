# OAuth 2.1 for ChatGPT Web

OAuth is disabled unless MCP_OAUTH_ENABLED=true. When enabled, /mcp accepts either the existing MCP_API_KEY or an OAuth access token. /action and /agent retain their independent credentials.

The relay hosts both the resource server and authorization server. The maintained @node-oauth/oauth2-server library handles authorization code, PKCE, token, refresh-token, and scope processing. The relay adds persistent JSON state, DCR, a local owner login, explicit consent, and MCP discovery documents. Access tokens, refresh tokens, and authorization codes are opaque; only SHA-256 hashes are persisted.

The production MCP URL is:

~~~text
https://mcp-relay.katebsaber.ir/mcp
~~~

## First-time configuration

Create the persistent data directory outside the checkout:

~~~bash
sudo install -d -o relay -g relay -m 700 /var/lib/desktop-commander-relay/oauth
~~~

Use the service account that actually runs desktop-commander-relay-server.service in place of relay when it differs.

Generate existing relay credentials as usual. Do not reuse them:

~~~bash
npm run secrets
~~~

Provision the owner password without putting it in shell history:

~~~bash
read -rsp 'OAuth owner password: ' MCP_OAUTH_OWNER_PASSWORD; echo
MCP_OAUTH_OWNER_PASSWORD="$MCP_OAUTH_OWNER_PASSWORD" npm run oauth:owner -- relay-owner
unset MCP_OAUTH_OWNER_PASSWORD
~~~

Copy the output into the existing /opt/DesktopCommanderRelay/.env without replacing its existing credentials:

~~~dotenv
MCP_OAUTH_ENABLED=true
MCP_OAUTH_ISSUER_URL=https://mcp-relay.katebsaber.ir
MCP_OAUTH_RESOURCE_URL=https://mcp-relay.katebsaber.ir/mcp
MCP_OAUTH_DATA_DIR=/var/lib/desktop-commander-relay/oauth
MCP_OAUTH_OWNER_USERNAME=relay-owner
MCP_OAUTH_OWNER_PASSWORD_HASH=<output-from-npm-run-oauth-owner>
MCP_OAUTH_SCOPES=mcp:read,mcp:write
MCP_OAUTH_DEFAULT_SCOPES=mcp:read,mcp:write
MCP_OAUTH_ALLOWED_TOOLS=relay_status,relay_list_devices
MCP_OAUTH_ALLOWED_DEVICE_IDS=
~~~

The default OAuth policy exposes only relay status/device discovery and authorizes no Desktop Commander device. To deliberately enable remote tools, add exact tool names and exact normalized device IDs:

~~~dotenv
MCP_OAUTH_ALLOWED_TOOLS=relay_status,relay_list_devices,read_file,list_directory
MCP_OAUTH_ALLOWED_DEVICE_IDS=home-pc
~~~

Use * only after reviewing the resulting exposure. The allowlist is enforced at tools/list and again at every tools/call; a client-supplied device_id cannot select a device outside the configured policy.

The built-in redirect policy accepts only:

- https://chatgpt.com/connector_platform_oauth_redirect
- https://chatgpt.com/connector/oauth/<callback-id>, with one URL-safe callback-id path segment

Set MCP_OAUTH_ALLOWED_REDIRECT_URIS to a comma-separated exact allowlist only when a separately reviewed client needs a different callback. Arbitrary redirect hosts and callback substitution are rejected.

## Deploy after git pull

The deployment script never pulls Git, overwrites .env, changes the systemd unit, rotates credentials, or restarts the service unless requested:

~~~bash
cd /opt/DesktopCommanderRelay
git pull --ff-only
bash scripts/deploy-ubuntu.sh
~~~

Review the build output and restart explicitly:

~~~bash
bash scripts/deploy-ubuntu.sh --restart
sudo systemctl status desktop-commander-relay-server.service
~~~

The script runs npm ci --include=dev, builds dist, validates OAuth configuration, and checks http://127.0.0.1:8787/healthz after an explicit restart. It leaves the existing .env and /var/lib/desktop-commander-relay/oauth/state.json in place.

The one-time systemd setup must use an EnvironmentFile with OAuth values and a writable MCP_OAUTH_DATA_DIR. If the service unit differs from the repository example, add the equivalent ReadWritePaths entry and ensure the service account owns the data directory.

## Reverse proxy

OAuth discovery, authorization, registration, token, and revocation routes must be publicly reachable on the same HTTPS hostname as /mcp. Preserve Host, Authorization, and X-Forwarded-Proto. /agent still needs WebSocket upgrade handling and /action still needs its independent Bearer header.

For HAProxy, review deploy/haproxy.cfg.example and merge it into the current HTTPS frontend/backend. The example is intentionally not a production replacement. The Nginx example remains at deploy/nginx.conf.example.

Do not trust arbitrary client-supplied forwarding headers. The relay validates forwarded Host against MCP_ALLOWED_HOSTS; configure it with mcp-relay.katebsaber.ir for this deployment.

## Discovery and local checks

When OAuth is enabled, these URLs return JSON metadata:

~~~bash
curl -fsS https://mcp-relay.katebsaber.ir/.well-known/oauth-protected-resource
curl -fsS https://mcp-relay.katebsaber.ir/.well-known/oauth-authorization-server
curl -fsS https://mcp-relay.katebsaber.ir/.well-known/openid-configuration
~~~

The protected-resource document identifies https://mcp-relay.katebsaber.ir/mcp as the resource and the relay origin as the authorization server. The authorization-server document advertises DCR, authorization-code + PKCE S256, public-client token authentication, refresh-token rotation, and the /oauth/* endpoints.

An unauthenticated MCP request returns a Bearer challenge containing the protected-resource metadata URL. Invalid or expired access tokens return 401. Missing scope returns 403 with insufficient_scope and a scope challenge.

The local test suite includes a real spawned-server OAuth flow covering DCR, owner login, consent, PKCE, token exchange, and MCP requests. A live ChatGPT Web connection still requires the public HTTPS proxy and cannot be proven from a local test run.

## Connecting ChatGPT Web

1. Deploy the configuration and verify the two discovery URLs.
2. In ChatGPT Web, add a custom Remote MCP connector/server using exactly https://mcp-relay.katebsaber.ir/mcp.
3. Start the connection. ChatGPT reads protected-resource metadata, performs DCR, and opens the relay authorization endpoint.
4. Sign in with the configured owner username and password, review the displayed scopes, and select Allow.
5. Return to ChatGPT and run relay_status. With a permitted device and tool allowlist, run an allowed Desktop Commander tool.

If the authorization page is not opened, inspect the MCP response's WWW-Authenticate header and confirm ChatGPT can reach /.well-known/oauth-protected-resource. If the callback fails, compare the exact callback URI with the accepted stable or callback-ID-specific patterns; do not weaken validation.

## Troubleshooting

- 401 before OAuth: confirm MCP_OAUTH_ENABLED=true, the public resource URL, and that the proxy forwards Authorization.
- invalid_client: the DCR request used a non-public token method, unsupported grant/response type, or unrecognized client ID. Keep existing client state unless a deliberate reset is required.
- invalid_redirect_uri: the redirect is not one of the two ChatGPT forms or is not an exact entry in MCP_OAUTH_ALLOWED_REDIRECT_URIS.
- invalid_target or metadata mismatch: MCP_OAUTH_RESOURCE_URL must exactly match https://mcp-relay.katebsaber.ir/mcp, including the path and without a trailing slash.
- PKCE errors: ChatGPT must send code_challenge_method=S256 and the token request must use the same one-time code_verifier. Authorization codes expire after MCP_OAUTH_AUTHORIZATION_CODE_LIFETIME_SEC and cannot be replayed.
- insufficient_scope: include mcp:read for initialization/listing and mcp:write for tool calls; reauthorize after changing scope policy.
- A tool is missing: add its exact name to MCP_OAUTH_ALLOWED_TOOLS and the selected normalized device ID to MCP_OAUTH_ALLOWED_DEVICE_IDS, then restart the relay.
- Login loops or callback failures: verify the HTTPS origin, forwarded Host, MCP_ALLOWED_HOSTS, secure cookies, and that public routes are not cached.
- State disappears after restart: check EnvironmentFile, directory ownership/mode, MCP_OAUTH_DATA_DIR, and ReadWritePaths. The relay fails closed rather than regenerating unreadable state.

Never print owner hashes, cookies, authorization codes, access tokens, refresh tokens, or request bodies into logs or bug reports.

## Disable and rollback

Disable OAuth without touching legacy credentials or persistent state:

~~~dotenv
MCP_OAUTH_ENABLED=false
~~~

Run the normal deployment script and restart explicitly. Existing MCP_API_KEY, Action API, agent connections, and the OAuth state directory remain unchanged. Re-enable OAuth later with the same owner hash and data directory.

To roll back a bad code revision:

~~~bash
cd /opt/DesktopCommanderRelay
git log --oneline -5
git checkout <known-good-revision>
bash scripts/deploy-ubuntu.sh --restart
~~~

Do not delete /var/lib/desktop-commander-relay/oauth during rollback. If a state migration is ever required, copy the directory first and follow release-specific migration notes. The repository does not deploy or rotate production credentials automatically.

