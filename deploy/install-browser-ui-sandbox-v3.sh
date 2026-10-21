#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
UNIT=desktop-commander-relay-sandbox.service
PROD=desktop-commander-relay-server.service
TARGET=/opt/DesktopCommanderRelay-sandbox
STATE=/var/lib/desktop-commander-relay-sandbox/oauth/state.json
ARCHIVE="$1"
[ "$EUID" = 0 ] && [ -f "$ARCHIVE" ] && [ -d "$TARGET/.git" ] || exit 1
[ "$(systemctl is-active "$UNIT")" = active ] || exit 1
[ "$(systemctl is-active "$PROD")" = active ] || exit 1
[ "$(git -C "$TARGET" rev-parse --short HEAD)" = 43a7088 ] || exit 1
git -C "$TARGET" diff --quiet -- package.json package-lock.json src/server/mcp.ts test/e2e.test.ts || exit 1
python3 - "$STATE" "$ARCHIVE" <<'PY'
import pathlib, json, tarfile, sys
f=pathlib.Path(sys.argv[1])
assert f.is_file() and not f.is_symlink()
assert (f.stat().st_uid,f.stat().st_gid)==(f.parent.stat().st_uid,f.parent.stat().st_gid)
with f.open() as h: json.load(h)
expected={'package.json','package-lock.json','src/server/mcp.ts','src/ui/browser-app.ts',
'scripts/build-browser-ui.mjs','test/e2e.test.ts','deploy/install-browser-ui-sandbox-v3.sh'}
with tarfile.open(sys.argv[2]) as tf:
    assert {x.name for x in tf}==expected
    assert all(x.isfile() for x in tf)
print('Preflight: OAuth ownership/JSON and archive validated')
PY
curl -fsS --max-time 5 http://127.0.0.1:8788/healthz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:8787/healthz >/dev/null
STAGE=$(mktemp -d /opt/deskbridge-ui-stage.XXXXXXXX)
BACKUP=$(mktemp -d /root/deskbridge-ui-recovery.XXXXXXXX)
echo "Stage: $STAGE"
echo "Recovery backup: $BACKUP"
cp -a "$TARGET/src" "$TARGET/test" "$TARGET/scripts" "$TARGET/tsconfig.json" "$STAGE/"
cp -a "$TARGET/package.json" "$TARGET/package-lock.json" "$STAGE/"
tar -xzf "$ARCHIVE" -C "$STAGE"
cd "$STAGE"
npm ci --no-audit --no-fund
MCP_OAUTH_ENABLED=false MCP_OAUTH_DATA_DIR="$STAGE/oauth-isolated" npm run check
node --input-type=module -e '
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {createMcpServer} from "./dist/server/mcp.js";
import {DeviceRegistry} from "./dist/server/device-registry.js";
const server=createMcpServer(new DeviceRegistry(undefined,10000,8));
const client=new Client({name:"ui-test",version:"1.0.0"},{capabilities:{}});
const [ct,st]=InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st),client.connect(ct)]);
try{
 const items=await client.listResources();
 const item=items.resources.find(x=>x.uri==="ui://deskbridge-sandbox/browser");
 if(!item)throw new Error("Missing MCP App resource");
 const data=await client.readResource({uri:item.uri});
 if(!data.contents[0]?.text?.includes("DeskBridge Sandbox"))throw new Error("Missing HTML");
 console.log("PASS: MCP App resource");
}finally{await client.close();await server.close();}
'
[ "$(stat -c '%u:%g' "$STATE")" = "$(stat -c '%u:%g' "$(dirname "$STATE")")" ] || exit 1
[ "$(systemctl is-active "$UNIT")" = active ] || exit 1
cd "$TARGET"
TRACKED='package.json package-lock.json src/server/mcp.ts test/e2e.test.ts'
NEWFILES='src/ui/browser-app.ts src/server/browser-ui.ts scripts/build-browser-ui.mjs'
tar -czf "$BACKUP/original.tar.gz" $TRACKED dist
for file in $NEWFILES; do
  if [ -f "$file" ]; then
    mkdir -p "$BACKUP/existing/$(dirname "$file")"
    cp -a "$file" "$BACKUP/existing/$file"
  fi
done
PUBLISHED=0
rollback() {
  trap - ERR INT TERM
  if [ "$PUBLISHED" = 1 ]; then
    echo 'ROLLBACK: restoring Sandbox only'
    systemctl stop "$UNIT" || true
    tar -xzf "$BACKUP/original.tar.gz" -C "$TARGET" || true
    for file in $NEWFILES; do
      if [ -f "$BACKUP/existing/$file" ]; then cp -a "$BACKUP/existing/$file" "$TARGET/$file";
      else rm -f "$TARGET/$file"; fi
    done
    if [ -d "$BACKUP/node_modules" ]; then
      [ ! -d "$TARGET/node_modules" ] || mv "$TARGET/node_modules" "$STAGE/failed_node_modules"
      mv "$BACKUP/node_modules" "$TARGET/node_modules" || true
    fi
    systemctl start "$UNIT" || true
  fi
  echo "Review backup: $BACKUP"
  systemctl is-active "$PROD" || true
  exit 1
}
trap rollback ERR INT TERM
PUBLISHED=1
for file in $TRACKED $NEWFILES; do
  mkdir -p "$TARGET/$(dirname "$file")"
  cp -a "$STAGE/$file" "$TARGET/$file"
done
cp -a "$STAGE/dist/." "$TARGET/dist/"
mv "$TARGET/node_modules" "$BACKUP/node_modules"
mv "$STAGE/node_modules" "$TARGET/node_modules"
systemctl restart "$UNIT"
HEALTHY=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:8788/healthz >/dev/null; then HEALTHY=1; break; fi
  sleep 1
done
[ "$HEALTHY" = 1 ] || false
sleep 5
[ "$(systemctl is-active "$UNIT")" = active ]
[ "$(stat -c '%u:%g' "$STATE")" = "$(stat -c '%u:%g' "$(dirname "$STATE")")" ]
curl -fsS --max-time 5 http://127.0.0.1:8788/healthz
echo
curl -fsS --max-time 5 http://127.0.0.1:8787/healthz
echo
trap - ERR INT TERM
echo 'SUCCESS: Sandbox MCP Apps deployed; Production not restarted'
echo "Recovery backup: $BACKUP"
