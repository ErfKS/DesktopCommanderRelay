#!/usr/bin/env bash
set -Eeuo pipefail

UNIT='desktop-commander-relay-sandbox.service'
PRODUCTION='desktop-commander-relay-server.service'
TARGET='/opt/DesktopCommanderRelay-sandbox'
STATE='/var/lib/desktop-commander-relay-sandbox/oauth/state.json'
ARCHIVE="${1:?Usage: bash install-browser-ui-sandbox-v2.sh /root/deskbridge-browser-ui.tar.gz}"
[ "$EUID" -eq 0 ] || { echo 'ERROR: Run as root'; exit 1; }
[ -f "$ARCHIVE" ] && [ -d "$TARGET/.git" ] || { echo 'ERROR: Bundle or sandbox missing'; exit 1; }
[ "$(systemctl is-active "$PRODUCTION")" = active ] || { echo 'ERROR: Production not healthy'; exit 1; }
[ "$(systemctl is-active "$UNIT")" = active ] || { echo 'ERROR: Sandbox must be healthy before upgrade'; exit 1; }
[ "$(git -C "$TARGET" rev-parse --short HEAD)" = 43a7088 ] || { echo 'ERROR: Unexpected sandbox revision'; exit 1; }
git -C "$TARGET" diff --quiet -- package.json package-lock.json src/server/mcp.ts ||
  { echo 'ERROR: Sandbox has tracked changes; stop here'; exit 1; }
python3 - "$STATE" "$ARCHIVE" <<'PY'
import json, pathlib, sys, tarfile, os, stat
state = pathlib.Path(sys.argv[1])
data_dir = state.parent
assert state.is_file() and not state.is_symlink()
assert (state.stat().st_uid, state.stat().st_gid) == (data_dir.stat().st_uid, data_dir.stat().st_gid), 'OAuth file owner mismatch'
assert stat.S_IMODE(state.stat().st_mode) == 0o600, 'OAuth state mode must be 0600'
with state.open(encoding='utf-8') as handle: json.load(handle)
allowed = {'src/server/mcp.ts', 'src/ui/browser-app.ts', 'scripts/build-browser-ui.mjs', 'package.json', 'package-lock.json', 'deploy/install-browser-ui-sandbox.sh', 'deploy/install-browser-ui-sandbox-v2.sh'}
with tarfile.open(sys.argv[2], 'r:gz') as tf:
    names = {m.name for m in tf}
    assert {'src/server/mcp.ts', 'src/ui/browser-app.ts', 'package.json', 'package-lock.json'} <= names
    for member in tf:
        assert member.name in allowed and member.isfile(), f'Unexpected archive member: {member.name}'
print('OAuth metadata and bundle validated (no secrets shown)')
PY

BACKUP=$(mktemp -d /root/deskbridge-browser-ui-recovery.XXXXXXXX)
chmod 700 "$BACKUP"
FILES=(package.json package-lock.json src/server/mcp.ts)
NEWFILES=(src/ui/browser-app.ts src/server/browser-ui.ts scripts/build-browser-ui.mjs deploy/install-browser-ui-sandbox.sh deploy/install-browser-ui-sandbox-v2.sh)
tar -czf "$BACKUP/original-tracked.tar.gz" -C "$TARGET" "${FILES[@]}"
mkdir -p "$BACKUP/previous-newfiles"
for path in "${NEWFILES[@]}"; do
  if [ -f "$TARGET/$path" ]; then
    mkdir -p "$BACKUP/previous-newfiles/$(dirname "$path")"
    cp -a -- "$TARGET/$path" "$BACKUP/previous-newfiles/$path"
  fi
done
echo "Recovery backup: $BACKUP"

rollback() {
  trap - ERR INT TERM
  echo 'ERROR: Attempting Sandbox-only rollback.'
  systemctl stop "$UNIT" || true
  tar -xzf "$BACKUP/original-tracked.tar.gz" -C "$TARGET"
  for path in "${NEWFILES[@]}"; do
    rm -f -- "$TARGET/$path"
  done
  echo 'Previous UI sources preserved in recovery backup, but removed from build tree.'
  ( cd "$TARGET" && npm ci --no-audit --no-fund && npm run build ) || echo 'WARNING: Local build recovery failed.'
  systemctl restart "$UNIT" || echo 'WARNING: Sandbox restart failed after recovery.'
  echo "Recovery files: $BACKUP"
  systemctl is-active "$PRODUCTION" || true
  exit 1
}
trap rollback ERR INT TERM

tar -xzf "$ARCHIVE" -C "$TARGET"
cd "$TARGET"
npm ci --no-audit --no-fund
npm run check
systemctl restart "$UNIT"
HEALTHY=0
for n in $(seq 1 15); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8788/healthz >/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
[ "$HEALTHY" = 1 ] || { echo 'ERROR: Sandbox health failed'; false; }
systemctl is-active --quiet "$UNIT"
systemctl is-active --quiet "$PRODUCTION"
curl --fail --silent --max-time 5 http://127.0.0.1:8787/healthz >/dev/null
trap - ERR INT TERM
echo
echo 'SUCCESS: Sandbox MCP Apps UI deployed. Production service untouched.'
echo "Rollback backup: $BACKUP"
