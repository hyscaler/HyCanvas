#!/bin/sh
# Checks a built HyCanvas image runs without root and still works for every
# way people deploy it: a fresh named volume, an arbitrary uid (Kubernetes
# runAsUser, OpenShift), a read-only root filesystem, and an upgrade onto a
# storage volume that an earlier image (which ran as root) created. Starts a
# throwaway Postgres alongside; cleans up everything it creates.
#
#   sh scripts/check-image.sh hycanvas:local
#   CONTAINER_CLI=docker sh scripts/check-image.sh hycanvas:local
#
# Prints PASS/FAIL per assertion and exits non-zero if any failed.
set -eu

IMAGE="${1:?usage: check-image.sh IMAGE}"
CLI="${CONTAINER_CLI:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}"
HELPER=docker.io/library/debian:bookworm-slim
TAG="hyc-check-$$"
FAILS=0

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }

# The app container joins the database container's network namespace, so the
# database cannot be removed while the app exists: remove the app first. One
# `rm -f db app` removed the app and left the database running, silently, on
# every run. Anything that survives is reported rather than hidden.
cleanup() {
  $CLI rm -f "$TAG-app" >/dev/null 2>&1 || true
  $CLI rm -f "$TAG-db" >/dev/null 2>&1 || true
  for v in fresh uid legacy ro; do $CLI volume rm -f "$TAG-$v" >/dev/null 2>&1 || true; done
  left=$($CLI ps -a --filter "name=$TAG" --format '{{.Names}}' 2>/dev/null)
  [ -z "$left" ] || echo "WARN  cleanup left containers behind: $left" >&2
}
trap cleanup EXIT INT TERM

# The app joins the database container's network namespace rather than a
# created network: no subnet to allocate, and the same on docker and podman.
$CLI run -d --name "$TAG-db" \
  -e POSTGRES_USER=hyc -e POSTGRES_PASSWORD=hyc -e POSTGRES_DB=hyc docker.io/library/postgres:16-alpine >/dev/null
i=0
until $CLI exec "$TAG-db" pg_isready -U hyc -d hyc >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { echo "Postgres did not start"; exit 2; }; sleep 1
done
JWT=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')

# start_app <volume> [extra run args...]: run the image against the volume.
start_app() {
  vol=$1; shift
  $CLI rm -f "$TAG-app" >/dev/null 2>&1 || true
  $CLI run -d --name "$TAG-app" --network "container:$TAG-db" "$@" \
    -e DATABASE_URL="postgresql://hyc:hyc@127.0.0.1:5432/hyc?schema=public" -e JWT_SECRET="$JWT" -e COOKIE_SECURE=false \
    -v "$vol:/app/.data/storage" "$IMAGE" >/dev/null
}

# healthy: 0 once /healthz answers, 1 if the container exits or 60s pass.
healthy() {
  i=0
  while [ "$i" -lt 60 ]; do
    [ "$($CLI inspect -f '{{.State.Running}}' "$TAG-app" 2>/dev/null)" = true ] || return 1
    $CLI exec "$TAG-app" curl -fsS http://localhost:8005/healthz >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}

in_app() { $CLI exec "$TAG-app" sh -c "$1"; }

# 0. The image itself owns its writable paths for group 0 with group write, so
# a new docker named volume (which copies the mount point's ownership on first
# use) and any uid in group 0 can write them. Read from the image, no volume:
# podman chowns a new volume to the container user, which would hide this.
owners=$($CLI run --rm --entrypoint stat "$IMAGE" -c '%n %g %A' /app /app/.data/storage 2>&1) || true
echo "$owners" | awk '$2 != 0 || substr($3, 6, 1) != "w" { bad = 1 } END { exit bad || NR != 2 }' \
  && pass "image grants group 0 write on /app and /app/.data/storage" \
  || fail "image does not grant group 0 write on /app and /app/.data/storage: $(echo "$owners" | tr '\n' ';')"

# 1. Fresh named volume, default user.
start_app "$TAG-fresh"
if healthy; then
  pass "boots on a fresh named volume"
  uid=$(in_app "awk '/^Uid:/{print \$2}' /proc/1/status")
  [ -n "$uid" ] && [ "$uid" != 0 ] && pass "server process runs as uid $uid, not root" || fail "server process runs as uid '${uid:-?}' (root or unknown)"
  bin=$($CLI image inspect -f '{{index .Config.Entrypoint 0}}' "$IMAGE")
  in_app "test -x '$bin' && ! test -w '$bin' && ! test -w \"\$(dirname '$bin')\"" \
    && pass "server cannot modify its own binary ($bin)" || fail "server can modify its own binary ($bin) or its directory"
  in_app 'test ! -e /app/hycanvas && test ! -L /app/hycanvas' \
    && pass "no executable compatibility symlink in writable /app" || fail "unsafe /app/hycanvas compatibility path remains"
  in_app 'touch /app/.env.probe && rm /app/.env.probe' \
    && pass "working directory /app is writable (setup wizard writes .env there)" || fail "working directory /app is not writable"
  in_app 'echo ok > /app/.data/storage/probe && rm /app/.data/storage/probe' \
    && pass "storage volume is writable" || fail "storage volume is not writable"
else
  fail "boots on a fresh named volume"; $CLI logs "$TAG-app" 2>&1 | tail -5
fi

# 2. Arbitrary uid in group 0 (Kubernetes runAsUser / OpenShift).
start_app "$TAG-uid" --user 12345:0
healthy && pass "boots as an arbitrary uid in group 0" || { fail "boots as an arbitrary uid in group 0"; $CLI logs "$TAG-app" 2>&1 | tail -5; }

# 3. Read-only root filesystem with a writable /tmp.
start_app "$TAG-ro" --read-only --tmpfs /tmp
healthy && pass "boots with a read-only root filesystem" || { fail "boots with a read-only root filesystem"; $CLI logs "$TAG-app" 2>&1 | tail -5; }

# 4. Upgrade: a storage volume created by an image that ran as root.
$CLI run --rm -u 0 -v "$TAG-legacy:/data" "$HELPER" sh -c 'echo legacy-bytes > /data/legacy.bin' >/dev/null
start_app "$TAG-legacy"
if healthy; then
  fail "a root-owned volume should stop the server at boot, but it started"
else
  $CLI logs "$TAG-app" 2>&1 | grep -q 'not writable' \
    && pass "a root-owned volume stops the server at boot with the fix in the log" \
    || { fail "a root-owned volume stopped the server without the expected message"; $CLI logs "$TAG-app" 2>&1 | tail -5; }
fi
app_uid=$($CLI image inspect -f '{{.Config.User}}' "$IMAGE" | cut -d: -f1)
$CLI run --rm -u 0 -v "$TAG-legacy:/data" "$HELPER" chown -R "${app_uid:-0}:0" /data
start_app "$TAG-legacy"
if healthy; then
  pass "after the documented chown the server boots on the upgraded volume"
  [ "$(in_app 'cat /app/.data/storage/legacy.bin')" = legacy-bytes ] \
    && pass "data written by the old image is intact and readable" || fail "data written by the old image is missing or unreadable"
else
  fail "after the documented chown the server boots on the upgraded volume"; $CLI logs "$TAG-app" 2>&1 | tail -5
fi

[ "$FAILS" -eq 0 ] && echo "all checks passed" || echo "$FAILS check(s) failed"
exit "$FAILS"
