#!/bin/sh
set -e

echo "🚀 Starting HyCanvas development environment..."

# Wait for PostgreSQL. Host/port are parsed from DATABASE_URL
# (postgresql://user:pass@host:port/db); falls back to the compose service name.
wait_for_postgres() {
  DB_HOST=$(echo "$DATABASE_URL" | sed -n 's#.*@\([^:/]*\).*#\1#p')
  DB_PORT=$(echo "$DATABASE_URL" | sed -n 's#.*@[^:/]*:\([0-9]*\).*#\1#p')
  DB_HOST="${DB_HOST:-db}"
  DB_PORT="${DB_PORT:-5432}"
  echo "⏳ Waiting for PostgreSQL at ${DB_HOST}:${DB_PORT}..."
  attempt=0
  until nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "❌ PostgreSQL did not become ready in time"
      exit 1
    fi
    sleep 2
  done
  echo "✅ PostgreSQL is ready."
}

wait_for_postgres

# Install deps into the named node_modules volume (fast once warm) and build the
# @hc/* packages: the frontend imports them from their compiled dist/, not source.
echo ""
echo "📦 Installing dependencies (npm install)..."
npm install --no-audit --no-fund

echo ""
echo "🔨 Building @hc/* packages..."
npm run build:packages

# The server also auto-migrates on boot (DB_AUTO_MIGRATE), but run it up front so
# the schema is ready before the frontend starts hitting the API.
echo ""
echo "🗃️  Applying database migrations..."
npm run db:migrate || echo "⚠️  Migration failed or already up to date; continuing"

echo ""
echo "🎯 Starting dev servers - backend on :8005 (air live-reload), frontend on :3000..."
# Backend via air (rebuild + restart on .go changes); frontend via next dev. The
# container env (compose `environment:` + the loaded .env) supplies all config to
# both, so neither needs the dotenv wrapper the native `npm run dev` uses.
exec npx concurrently -k -n backend,frontend -c blue,green \
  "cd backend && air -c .air.toml" \
  "npm run dev:frontend"
