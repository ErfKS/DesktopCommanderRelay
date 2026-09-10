# Design notes

## Why this is not a clone of mcp.desktopcommander.app

The inspected DesktopCommanderMCP source shows that its built-in remote device path is coupled to a hosted backend:

- `src/remote-device/device.ts` defaults `MCP_SERVER_URL` to `https://mcp.desktopcommander.app` and fetches `/api/mcp-info`.
- `src/remote-device/device-authenticator.ts` expects `/device/start` and `/device/poll` for a PKCE device authorization flow.
- `src/remote-device/remote-channel.ts` then uses Supabase Auth, Realtime Broadcast/Presence, and Postgres tables such as `mcp_devices` and `mcp_remote_calls`.

Recreating those endpoints alone would not be enough; a compatible implementation would also have to reproduce the Supabase data model, auth semantics, row-level access rules, realtime channel behavior, presence, heartbeat tiers, and call state transitions. That is unnecessary for a private self-hosted bridge.

## Chosen boundary

Desktop Commander already exposes a clean public boundary locally: standard MCP over stdio. The relay agent consumes that boundary with the official MCP TypeScript SDK and forwards only the tool descriptions and tool calls over a small authenticated WebSocket protocol.

This makes the upstream project an unchanged dependency rather than a fork.

## Relay wire protocol v1

Agent -> server hello:

```json
{
  "type": "hello",
  "protocol": 1,
  "deviceId": "home-pc",
  "deviceName": "my-computer",
  "agentVersion": "0.1.0",
  "tools": []
}
```

Server -> agent call:

```json
{
  "type": "tool_call",
  "id": "uuid",
  "name": "read_file",
  "arguments": {},
  "metadata": { "transport": "desktop-commander-relay" }
}
```

Agent -> server result:

```json
{
  "type": "tool_result",
  "id": "uuid",
  "ok": true,
  "result": { "content": [] }
}
```

The relay does not automatically replay a call with a new ID after uncertain network failure. Avoiding automatic replay is deliberate because many Desktop Commander tools have side effects.

## MCP-facing transport

The relay server uses the official TypeScript SDK v2 `createMcpHandler` with `legacy: 'stateless'`, adapted to Node/Express. This serves the current MCP protocol and the 2025 legacy protocol while avoiding a long-lived AI-client session in the relay. Each request obtains a fresh MCP server view, so the selected device's current tool list is reflected after the agent refreshes it.

The relay's private agent protocol remains version 1. It has explicit message-size, identifier, tool-count, queue, timeout, and result-cache limits. Calls are not automatically replayed after a disconnect because replaying side-effecting Desktop Commander operations would be unsafe.

## Known follow-up areas

A production review should consider:

- per-device agent tokens instead of one shared `AGENT_TOKEN` when many devices are used;
- OAuth 2.1 / Protected Resource Metadata if a target MCP host cannot provide a static Bearer token;
- durable call audit metadata without recording sensitive args/results;
- dynamic tool-list change notifications if the selected AI client requires push rather than periodic refresh;
- proxy-aware client IP rate limiting;
- integration tests against the exact DesktopCommanderMCP version in the sibling source folder;
- a Windows service wrapper for the local agent;
- optional mutual TLS between the agent and relay for higher assurance.
