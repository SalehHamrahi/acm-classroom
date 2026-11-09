#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="${APP_DIR:-/opt/acm-classroom}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js executable was not found in PATH." >&2
  exit 1
fi
# The Node script reads BACKUP_DIR and BACKUP_RETENTION_DAYS from .env. It uses
# pg_dump creates a consistent custom-format snapshot without stopping the app.
exec "$NODE_BIN" "$APP_DIR/scripts/create-backup.js"
