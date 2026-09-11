# Security

DesktopCommanderRelay exposes a local DesktopCommanderMCP instance to remote clients through two authenticated interfaces: the MCP endpoint and, optionally, the HTTP Action API. Treat all relay credentials as high-value secrets.

## Production requirements

- Use HTTPS/WSS. Do not expose the raw Node HTTP listener directly to the Internet.
- Keep `MCP_API_KEY`, `ACTION_API_KEY`, and `AGENT_TOKEN` different, random, and outside source control. At least 256 bits of entropy is recommended for each.
- Keep `.env` and agent environment files outside source control and readable only by the service account.
- Bind Node to loopback when a reverse proxy runs on the same host.
- Keep Desktop Commander's own `allowedDirectories`, blocked commands, and related local security settings configured conservatively.
- Do not enable `ALLOW_INSECURE_LOCAL` on a public deployment.
- Prefer a dedicated DNS name and firewall rules for the relay.
- Set `MCP_ALLOWED_HOSTS` to the exact public relay hostname(s) before binding Node publicly. This protects HTTP and WebSocket routes against Host-header and DNS-rebinding mistakes.
- Set `MCP_ALLOWED_ORIGINS` when browser-originated MCP or agent connections are expected. An `Origin` header that does not match the configured allowlist is rejected.
- Keep private ChatGPT Custom GPT integrations private and never share their Action credentials.

## Credentials and trust boundaries

DesktopCommanderRelay uses separate credentials for separate interfaces:

- `MCP_API_KEY` authenticates remote MCP requests to `/mcp`.
- `ACTION_API_KEY` authenticates HTTP Action requests to `/action/*`.
- `AGENT_TOKEN` authenticates Relay Agents connecting over WebSocket.

Do not reuse one credential for another interface.

### MCP interface

The MCP path is a broad remote-control interface. The server authenticates the MCP client, selects an authenticated device, and forwards DesktopCommander tool calls to the selected agent.

For normal DesktopCommander tools, the MCP relay does not reinterpret tool arguments into a separate per-tool authorization model. A client holding `MCP_API_KEY` may call the tools exposed by the selected agent, subject to DesktopCommanderMCP's own restrictions and the relay's MCP behavior.

Use a separate relay deployment or a dedicated authorization layer when different MCP clients must receive different capabilities.

### Action interface

The HTTP Action interface applies an additional server-side tool policy before forwarding calls to DesktopCommanderMCP.

The following tools are currently hidden from `/action/tools` and rejected when called directly through `/action`:

```text
set_config_value
start_process
interact_with_process
read_process_output
force_terminate
kill_process
```

A blocked Action call returns HTTP `403`.

This filtering applies only to the HTTP Action interface. It does not remove those tools from DesktopCommanderMCP and does not reduce the capabilities of a separately authenticated MCP client.

The current Action policy is a blocklist. For stricter deployments, prefer an explicit allowlist so newly added upstream DesktopCommander tools are not exposed automatically.

## Filesystem restrictions

Filesystem restrictions are enforced by DesktopCommanderMCP on the controlled computer through settings such as `allowedDirectories`.

When `allowedDirectories` is configured, DesktopCommander filesystem tools should reject paths outside the configured directories.

Important considerations:

- Verify the semantics of an empty `allowedDirectories` list before exposing a remote client; depending on DesktopCommanderMCP configuration, an empty list may mean unrestricted filesystem access.
- The current Action API blocks `set_config_value`, so an Action client cannot remove or expand `allowedDirectories` through the Action adapter.
- The current Action API also blocks terminal/process execution tools listed above so they cannot trivially bypass filesystem-only path restrictions through Actions.
- These protections do not automatically constrain a separate local or MCP client that has broader DesktopCommander tool access.
- Operating-system permissions are a stronger final boundary. For high-assurance deployments, run the Relay Agent/DesktopCommander process under a dedicated OS account with access only to the directories it requires.

## Device selection

The server can track multiple connected agents.

Normal tool calls use the device selected by `TARGET_DEVICE_ID`, or the relay's single-device fallback when only one agent is connected.

`/action/status`, `relay_status`, and `relay_list_devices` may reveal connected-device metadata to authenticated clients. Do not treat device names or IDs as secrets, but avoid placing sensitive information in them.

## Logs

The relay intentionally avoids logging tool arguments and tool results in normal operation because they may contain file contents, credentials, command output, or other sensitive data.

Avoid adding debug logging that records:

- Bearer tokens or environment secrets
- tool arguments or full tool results
- file contents
- command output containing credentials or private data

## Operational guidance

- Rotate any relay credential that may have been exposed.
- Restart or rebuild the relay after security-sensitive source changes so the running deployment matches the reviewed code.
- Review `/action/tools` after DesktopCommanderMCP upgrades because the upstream tool list may change.
- Keep DesktopCommanderMCP, Node.js, the operating system, and reverse proxy patched.
- Back up configuration securely, but never commit production secrets to Git.
