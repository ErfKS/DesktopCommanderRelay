#!/usr/bin/env bash
set -Eeuo pipefail

BUNDLE="${1:?Usage: bash install-browser-ui-sandbox.sh /path/to/archive.tar.gz}"
TARGET=/opt/DesktopCommanderRelay-sandbox
UNIT=desktop-commander-relay-sandbox.service
if [[ ${EUID} -ne 0 ]]; then echo 'Run as root on id-721626'; exit 1; fi
if [[ ! -f "$BUNDLE" || ! -d "$TARGET/.git" ]]; then echo 'Bundle or sandbox checkout missing'; exit 1; fi
if [[ "$(git -C "$TARGET" rev-parse --short HEAD)" != "43a7088" ]]; then
  echo 'Sandbox checkout has unexpected commit; refusing to overwrite'; exit 1
fi
if ! git -C "$TARGET" diff --quiet -- src/server/mcp.ts package.json package-lock.json; then
  echo 'Sandbox has local modifications in target files; refusing to overwrite'; exit 1
fi
if [[ "$(systemctl is-active desktop-commander-relay-server.service)" != "active" ]]; then
  echo 'Production Relay not active; investigate before applying'; exit 1
fi
BACKUP=$(mktemp -d /root/deskbridge-sandbox-ui-backup.XXXXXXXX)
tar -czf "$BACKUP/originals.tar.gz" -C "$TARGET" src/server/mcp.ts package.json package-lock.json
echo "Backup: $BACKUP/originals.tar.gz"
rollback() {
  echo 'Deployment failed, restoring Sandbox files and dependencies...'
  tar -xzf "$BACKUP/originals.tar.gz" -C "$TARGET"
  (cd "$TARGET" && npm ci --no-audit --no-fund && npm run build) || true
  systemctl restart "$UNIT" || true
  exit 1
}
trap rollback ERR
tar -tzf "$BUNDLE" | grep -Fx 'src/server/mcp.ts'
tar -tzf "$BUNDLE" | grep -Fx 'src/ui/browser-app.ts'
tar -xzf "$BUNDLE" -C "$TARGET"
cd "$TARGET"
npm ci --no-audit --no-fund
npm run check
systemctl restart "$UNIT"
sleep 3
systemctl is-active --quiet "$UNIT"
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8788/healthz
systemctl is-active --quiet desktop-commander-relay-server.service
trap - ERR
echo
echo 'Sandbox MCP Apps UI server installed. Production Relay was not restarted.'
echo "Rollback source backup: $BACKUP/originals.tar.gz"
