#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations..."
# Retry: the app may start before Postgres finishes accepting connections, even
# with a compose healthcheck. Give it a few attempts before giving up.
attempt=1
until npx prisma migrate deploy; do
  if [ "$attempt" -ge 10 ]; then
    echo "[entrypoint] Database not reachable after $attempt attempts; exiting."
    exit 1
  fi
  echo "[entrypoint] Migration attempt $attempt failed; retrying in 3s..."
  attempt=$((attempt + 1))
  sleep 3
done

# Demo data. SEED controls what happens on start:
#   if-empty (default) - load the 3 demo cases only into an empty database, so
#                        restarts never wipe existing cases or decision history
#   reset              - wipe everything and reload the demo cases
#   false              - never seed
SEED="${SEED:-if-empty}"
if [ "$SEED" != "false" ]; then
  echo "[entrypoint] Seeding demo data (mode: $SEED)..."
  SEED_MODE="$SEED" npx prisma db seed || echo "[entrypoint] Seed step skipped or failed (continuing)."
fi

echo "[entrypoint] Starting application..."
exec "$@"
