#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup-ubuntu-vps.sh"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/acm-classroom}"
DOMAIN="acm-classroom.ir"
if [[ ! -f "$APP_DIR/package.json" || ! -f "$APP_DIR/server/index.js" ]]; then
  echo "Project files not found in $APP_DIR. Extract the project ZIP there first."
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "This setup script targets Ubuntu 24.04 LTS. Detected: ${PRETTY_NAME:-unknown}"
  echo "For another OS, follow deploy/DEPLOYMENT-fa.md manually."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg unzip debian-keyring debian-archive-keyring apt-transport-https ufw openssl postgresql-client-16

# Node.js 24 is the Active LTS line at the time this package was prepared.
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/acm-nodesource-setup.sh
bash /tmp/acm-nodesource-setup.sh
apt-get install -y nodejs

# Docker Engine from Docker's official Ubuntu apt repository.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<DOCKER_APT
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER_APT

# Caddy's official stable Ubuntu/Debian repository.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
systemctl enable --now docker

if ! getent group docker >/dev/null; then
  echo "Docker group was not created by the Docker package; stopping."
  exit 1
fi
if ! id acmclassroom >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin acmclassroom
fi
# The application already needs Docker access for isolated student-code runners.
usermod -aG docker acmclassroom

mkdir -p "$APP_DIR/data"
# The app and backup timer share this private directory. Running the backup
# timer as acmclassroom keeps snapshots readable by the admin dashboard.
mkdir -p /var/backups/acm-classroom
chown -R acmclassroom:acmclassroom /var/backups/acm-classroom
chmod 700 /var/backups/acm-classroom
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/deploy/.env.production.example" "$APP_DIR/.env"
  echo "Created production .env for https://$DOMAIN"
else
  CURRENT_ORIGIN="$(grep -m1 '^APP_ORIGIN=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '\r' || true)"
  if [[ "$CURRENT_ORIGIN" != "https://$DOMAIN" ]]; then
    echo "ERROR: $APP_DIR/.env has APP_ORIGIN='$CURRENT_ORIGIN'. Set it to https://$DOMAIN first."
    echo "No existing .env was overwritten."
    exit 1
  fi
fi

# Switch production to a private, persistent PostgreSQL 16 container. Existing
# SQLite files are deliberately left untouched; this clean migration does not
# import old records because this deployment is intended to start with no data.
env_value() {
  local key="$1"
  grep -m1 "^${key}=" "$APP_DIR/.env" | cut -d= -f2- | tr -d '\r' || true
}
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}
POSTGRES_DB="$(env_value POSTGRES_DB)"
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_PASSWORD="$(env_value POSTGRES_PASSWORD)"
POSTGRES_DB="${POSTGRES_DB:-acm_classroom}"
POSTGRES_USER="${POSTGRES_USER:-acm_classroom}"
if [[ ! "$POSTGRES_DB" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ || ! "$POSTGRES_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]]; then
  echo "POSTGRES_DB/POSTGRES_USER must contain only letters, digits and underscores, and start with a letter or underscore."
  exit 1
fi
if [[ -z "$POSTGRES_PASSWORD" || "$POSTGRES_PASSWORD" == CHANGE_ME_* ]]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
fi
if [[ ! "$POSTGRES_PASSWORD" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "POSTGRES_PASSWORD must be 64 hexadecimal characters. Generate one with: openssl rand -hex 32"
  exit 1
fi
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}?sslmode=disable"
set_env_value DATABASE_DRIVER postgres
set_env_value POSTGRES_DB "$POSTGRES_DB"
set_env_value POSTGRES_USER "$POSTGRES_USER"
set_env_value POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_env_value DATABASE_URL "$DATABASE_URL"
TEST_DATABASE_URL="$(env_value TEST_DATABASE_URL)"
DEFAULT_TEST_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/acm_classroom_test?sslmode=disable"
if [[ -z "$TEST_DATABASE_URL" || "$TEST_DATABASE_URL" == *CHANGE_ME_* ]]; then
  TEST_DATABASE_URL="$DEFAULT_TEST_DATABASE_URL"
fi
set_env_value TEST_DATABASE_URL "$TEST_DATABASE_URL"
set_env_value BACKUP_DIR /var/backups/acm-classroom
set_env_value BACKUP_RETENTION_DAYS "$(env_value BACKUP_RETENTION_DAYS | grep -E '^[0-9]+$' || echo 30)"

chown -R acmclassroom:acmclassroom "$APP_DIR"
chmod 600 "$APP_DIR/.env"
chmod 750 "$APP_DIR/data"

# Always build by default so an older dist/ folder from a previous version cannot
# accidentally survive an update. Use SKIP_NPM_BUILD=1 only after uploading the
# freshly built dist/ for this exact release from a workstation.
if [[ "${SKIP_NPM_BUILD:-0}" == "1" ]]; then
  if [[ ! -f "$APP_DIR/dist/index.html" ]]; then
    echo "SKIP_NPM_BUILD=1 requires a freshly built dist/index.html."
    exit 1
  fi
  echo "Skipping npm install/build as requested; using the uploaded dist/."
  runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm test"
else
  echo "Installing npm packages and building the production frontend..."
  runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm ci && npm test && npm run build && npm prune --omit=dev"
fi

echo "Starting the private PostgreSQL 16 database..."
(
  cd "$APP_DIR"
  docker compose config --quiet
  docker compose up -d postgres
)
POSTGRES_READY=0
for attempt in $(seq 1 45); do
  if docker exec acm-classroom-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    POSTGRES_READY=1
    break
  fi
  sleep 2
done
if [[ "$POSTGRES_READY" != "1" ]]; then
  echo "PostgreSQL did not become ready. Inspect: cd $APP_DIR && docker compose logs postgres"
  exit 1
fi
runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm run db:check"

if [[ "${RUN_POSTGRES_COMPAT_TESTS:-1}" != "0" ]]; then
  if [[ "$TEST_DATABASE_URL" == "$DEFAULT_TEST_DATABASE_URL" ]]; then
    TEST_DB_EXISTS="$(docker exec acm-classroom-postgres psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'acm_classroom_test'")"
    if [[ "$TEST_DB_EXISTS" != "1" ]]; then
      docker exec acm-classroom-postgres createdb -U "$POSTGRES_USER" acm_classroom_test
    fi
  fi
  echo "Running the API compatibility suite against the isolated PostgreSQL test database..."
  runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm run test:postgres"
else
  echo "Skipping the PostgreSQL API compatibility suite because RUN_POSTGRES_COMPAT_TESTS=0."
fi

if ! docker image inspect python:3.13-alpine >/dev/null 2>&1; then
  echo "Downloading Python judge image..."
  if ! docker pull python:3.13-alpine; then
    echo "Could not pull from Docker Hub. On a networked computer, run:"
    echo "  docker pull python:3.13-alpine"
    echo "  docker save python:3.13-alpine -o python-3.13-alpine.tar"
    echo "Upload the tar to the VPS, run 'docker load -i python-3.13-alpine.tar', then rerun this script."
    exit 1
  fi
fi

if ! docker image inspect acm-cpp-runner:17 >/dev/null 2>&1; then
  echo "Building the isolated C++ judge image..."
  runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm run docker:build-cpp"
fi

echo "Create or verify the first administrator account..."
runuser -u acmclassroom -- env HOME="$APP_DIR" bash -lc "cd '$APP_DIR' && npm run setup:admin"

install -o root -g root -m 0644 "$APP_DIR/deploy/acm-classroom.service" /etc/systemd/system/acm-classroom.service
install -o root -g root -m 0755 "$APP_DIR/deploy/backup-acm-classroom.sh" /usr/local/sbin/acm-classroom-backup
install -o root -g root -m 0644 "$APP_DIR/deploy/acm-classroom-backup.service" /etc/systemd/system/acm-classroom-backup.service
install -o root -g root -m 0644 "$APP_DIR/deploy/acm-classroom-backup.timer" /etc/systemd/system/acm-classroom-backup.timer

if [[ -f /etc/caddy/Caddyfile ]]; then
  cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -o root -g root -m 0644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable acm-classroom
systemctl restart acm-classroom
systemctl enable --now acm-classroom-backup.timer
systemctl enable caddy

# Open required ports if UFW is already enabled. Do not enable UFW automatically,
# which could lock out a server using a non-standard SSH port.
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
systemctl restart caddy

cat <<NEXT

ACM Classroom host preparation is complete.
App service: systemctl status acm-classroom
PostgreSQL container: cd $APP_DIR && docker compose ps
PostgreSQL logs: cd $APP_DIR && docker compose logs -f postgres
Caddy service: systemctl status caddy
Logs: journalctl -u acm-classroom -f
Health check: curl -fsS http://127.0.0.1:3002/api/health

Next steps:
1. Confirm DNS A record for $DOMAIN points to this server's public IPv4.
2. Ensure the provider firewall and UFW allow inbound TCP 22, 80 and 443.
3. The installer asks for a first admin on a fresh database; if a database was migrated, it preserves the existing admin.
4. If the certificate is not issued yet, inspect: journalctl -u caddy -n 100 --no-pager

SECURITY: ACM Classroom invokes Docker to run untrusted student code. The docker
 group is root-equivalent. Use a dedicated VPS only and do not host sensitive
unrelated workloads on this machine.
NEXT
