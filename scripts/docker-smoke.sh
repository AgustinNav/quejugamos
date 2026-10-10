#!/usr/bin/env bash
# Build the image, run it, wait until Docker reports it healthy, hit /healthz, then stop it with
# SIGTERM and fail if the app ignored the signal. Used by CI; runs the same way locally.
#
# Usage: ./scripts/docker-smoke.sh [image-tag]
set -euo pipefail

IMAGE="${1:-quejugamos:smoke}"
CONTAINER="quejugamos-smoke-$$"
HOST_PORT="${HOST_PORT:-18080}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"
# Docker and Cloud Run both SIGKILL 10 s after SIGTERM. Exit 137 = signal ignored (hard failure).
MAX_STOP_S="${MAX_STOP_S:-8}"

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; docker logs "${CONTAINER}" >&2 2>&1 || true; exit 1; }
cleanup() { docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "Building ${IMAGE}"
docker build --tag "${IMAGE}" .

log "Image size: $(docker image inspect "${IMAGE}" --format '{{.Size}}' | awk '{printf "%.1f MB", $1/1000/1000}')"
user="$(docker image inspect "${IMAGE}" --format '{{.Config.User}}')"
[[ -n "${user}" && "${user}" != "root" && "${user}" != "0" ]] || die "Image runs as root (User='${user}')"
log "Runtime user: ${user}"

log "Starting container on port ${HOST_PORT}"
# --read-only rootfs on purpose: proves the app survives an unwritable cache file.
docker run --detach --name "${CONTAINER}" --publish "127.0.0.1:${HOST_PORT}:8080" \
  --read-only --tmpfs /tmp "${IMAGE}" >/dev/null

log "Waiting up to ${HEALTH_TIMEOUT_S}s for HEALTHCHECK to report healthy"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Health.Status}}')" == "healthy" ]]; do
  [[ "$(docker inspect "${CONTAINER}" --format '{{.State.Running}}')" == "true" ]] || die "Container exited"
  (( SECONDS < deadline )) || die "Container did not become healthy in ${HEALTH_TIMEOUT_S}s"
  sleep 2
done

log "GET /healthz from the host"
body="$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${HOST_PORT}/healthz")"
[[ "${body}" == *'"ok":true'* ]] || die "Unexpected /healthz body: ${body}"

log "Stopping with SIGTERM (must exit in < ${MAX_STOP_S}s)"
start=${SECONDS}
docker stop --time 10 "${CONTAINER}" >/dev/null
elapsed=$((SECONDS - start))
exit_code="$(docker inspect "${CONTAINER}" --format '{{.State.ExitCode}}')"
[[ "${exit_code}" != "137" ]] || die "Exit 137 after ${elapsed}s: the app ignored SIGTERM and was SIGKILLed"
[[ "${exit_code}" == "0" || "${exit_code}" == "143" ]] || die "Unexpected exit code ${exit_code} after SIGTERM"
(( elapsed < MAX_STOP_S )) || log "WARN: graceful stop took ${elapsed}s (close() likely hit the app's fallback timer)"

log "OK: healthy, /healthz=${body}, stopped in ${elapsed}s (exit ${exit_code})"
