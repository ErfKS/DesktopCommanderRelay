# Security

DesktopCommanderRelay grants a remote MCP client access to whatever the connected DesktopCommanderMCP instance is allowed to do. Treat both relay secrets as high-value credentials.

## Production requirements

- Use HTTPS/WSS. Do not expose the raw Node HTTP listener directly to the Internet.
- Keep `MCP_API_KEY` and `AGENT_TOKEN` different and random (at least 256 bits recommended).
- Keep `.env` and agent environment files outside source control and readable only by the service account.
- Bind Node to loopback when a reverse proxy runs on the same host.
- Keep Desktop Commander's own allowed directories and blocked commands configured conservatively.
- Do not enable `ALLOW_INSECURE_LOCAL` on a public deployment.
- Prefer a dedicated DNS name and firewall rules for the relay.
- Set `MCP_ALLOWED_HOSTS` to the exact public relay hostname(s) before binding Node publicly. This protects both HTTP and WebSocket routes against Host-header/DNS-rebinding mistakes.
- Set `MCP_ALLOWED_ORIGINS` when browser-originated MCP or agent connections are expected; an Origin header not matching the configured host allowlist is rejected.

## Trust boundaries

The server does not parse or reinterpret Desktop Commander tool arguments. It authenticates the remote MCP client, selects an authenticated device, and forwards the tool call. The local DesktopCommanderMCP process remains responsible for command and filesystem policy.

## Logs

The relay intentionally avoids logging tool arguments and tool results in normal operation because they can contain file contents, credentials, command output, or other sensitive data.

The relay is not an authorization boundary between individual Desktop Commander tools. Anyone holding `MCP_API_KEY` can call every tool exposed by the selected local agent, subject only to the upstream DesktopCommanderMCP restrictions. Use separate relay deployments or a future per-device authorization layer when different remote users must receive different capabilities.
