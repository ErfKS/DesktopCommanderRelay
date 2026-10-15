#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="desktop-commander-relay-server.service"
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --help|-h)
      echo "Usage: bash scripts/deploy-ubuntu.sh [--restart]"
      echo "Builds and validates the current checkout. Restarts systemd only with --restart."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null
command -v npm >/dev/null
test -f .env || { echo ".env is missing; copy and configure it without overwriting existing credentials." >&2; exit 1; }

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"
echo "Installing locked dependencies..."
npm ci --include=dev
echo "Building TypeScript..."
npm run build
echo "Validating configuration..."
npm run validate:config

if [[ "$RESTART" -eq 1 ]]; then
  sudo systemctl restart "$SERVICE_NAME"
  sudo systemctl is-active --quiet "$SERVICE_NAME"
  curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8787/healthz >/dev/null
  echo "Updated build is active and healthz responded successfully."
else
  echo "Build and validation completed. The service was not restarted."
  echo "Review the diff, then run: sudo systemctl restart $SERVICE_NAME"
fi

echo "Rollback: restore the previous Git revision, run this script again, and restart the service. Keep .env and MCP_OAUTH_DATA_DIR unchanged."
