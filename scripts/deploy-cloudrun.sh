#!/usr/bin/env bash
# Deploy GameMatch to Google Cloud Run from source (Cloud Build builds the Dockerfile).
# Idempotent: safe to re-run; every run creates a new revision and shifts 100% traffic to it.
#
# Usage:
#   PROJECT_ID=my-project ./scripts/deploy-cloudrun.sh
#   PROJECT_ID=my-project REGION=us-east1 STEAM_CC=us ./scripts/deploy-cloudrun.sh
#
# Requires: gcloud authenticated (`gcloud auth login`) and a billing account linked to the project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"         # Tier 1 region: cheapest prices, full free tier.
SERVICE="${SERVICE:-gamematch}"
STEAM_CC="${STEAM_CC:-ar}"
MEMORY="${MEMORY:-512Mi}"
# Every open SSE stream occupies one concurrency slot on the single instance. Idle sockets are cheap
# for Node, and with request-based billing cost depends on instance active time, not on concurrency.
CONCURRENCY="${CONCURRENCY:-1000}"
# Cloud Run maximum (60 min). SSE clients (EventSource) reconnect automatically when it is reached.
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-3600}"
AR_REPO="cloud-run-source-deploy"       # Repository auto-created by `gcloud run deploy --source`.
KEEP_IMAGES="${KEEP_IMAGES:-3}"

log() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_prerequisites() {
  command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found. See docs/DEPLOY.md."
  [[ -n "${PROJECT_ID}" ]] || die "PROJECT_ID is not set and no default gcloud project is configured."
  gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
    || die "No active gcloud account. Run: gcloud auth login"
  local billing_enabled
  billing_enabled="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)')"
  [[ "${billing_enabled}" == "True" ]] || die "Billing is not enabled on ${PROJECT_ID}. Cloud Run needs it even within the free tier."
}

enable_apis() {
  log "Enabling required APIs (no-op if already enabled)"
  gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    --project="${PROJECT_ID}"
}

deploy_service() {
  log "Deploying ${SERVICE} to ${REGION} (project ${PROJECT_ID})"
  # --cpu-throttling        = request-based billing: billed only while a request (incl. an open SSE
  #                            stream) is in flight. Cheapest for a service idle most of the month.
  # --max-instances=1       = in-memory state requires exactly one instance; also caps worst-case cost.
  # --cpu=1                 = minimum allowed when concurrency > 1 (sub-1 vCPU forces concurrency=1).
  gcloud run deploy "${SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --source=. \
    --platform=managed \
    --allow-unauthenticated \
    --port=8080 \
    --cpu=1 \
    --memory="${MEMORY}" \
    --cpu-throttling \
    --min-instances=0 \
    --max-instances=1 \
    --concurrency="${CONCURRENCY}" \
    --timeout="${REQUEST_TIMEOUT}" \
    --set-env-vars="TRUST_PROXY=1,STEAM_CC=${STEAM_CC}" \
    --labels="app=gamematch,managed-by=deploy-script" \
    --quiet
}

# Each source deploy pushes a new image; Artifact Registry's free tier is only 0.5 GB.
apply_image_cleanup_policy() {
  if ! gcloud artifacts repositories describe "${AR_REPO}" \
      --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
    log "Artifact Registry repo ${AR_REPO} not found; skipping cleanup policy"
    return 0
  fi
  log "Applying cleanup policy: keep the ${KEEP_IMAGES} most recent images"
  local policy_file
  policy_file="$(mktemp)"
  # shellcheck disable=SC2064  # expand now: the local var is gone when the trap fires.
  trap "rm -f '${policy_file}'" RETURN
  cat >"${policy_file}" <<EOF
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": ${KEEP_IMAGES}}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}}
]
EOF
  gcloud artifacts repositories set-cleanup-policies "${AR_REPO}" \
    --project="${PROJECT_ID}" --location="${REGION}" \
    --policy="${policy_file}" --no-dry-run --quiet
}

smoke_test() {
  local url
  url="$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
  log "Smoke test: ${url}/healthz"
  curl --fail --silent --show-error --max-time 30 --retry 3 --retry-delay 2 "${url}/healthz"
  printf '\n\nDeployed: %s\n' "${url}"
}

main() {
  require_prerequisites
  enable_apis
  deploy_service
  apply_image_cleanup_policy
  smoke_test
  log "Reminder: if you have not yet, create the budget alert: PROJECT_ID=${PROJECT_ID} ./scripts/setup-budget.sh"
}

main "$@"
