#!/usr/bin/env bash
# Deploy Que Jugamos to Google Cloud Run. Single source of truth for the service flags: used by humans
# and by .github/workflows/deploy.yml.
# Idempotent: safe to re-run; every run creates a new revision and shifts 100% traffic to it.
#
# Usage (from the repo root):
#   PROJECT_ID=my-project ./scripts/deploy-cloudrun.sh                 # build with Cloud Build (--source)
#   PROJECT_ID=my-project IMAGE=us-central1-docker.pkg.dev/my-project/quejugamos/app:abc123 \
#     BOOTSTRAP=0 ./scripts/deploy-cloudrun.sh                         # deploy a prebuilt image (CI)
#
# Env:
#   PROJECT_ID  GCP project (default: current gcloud project)
#   REGION      default us-central1 (Tier 1: cheapest prices, full free tier)
#   IMAGE       optional prebuilt image; when empty, deploys with --source=.
#   BOOTSTRAP   1 (default) = also check billing, enable APIs and set the image cleanup policy.
#               CI sets 0 so its deploy identity only needs run.admin + serviceAccountUser.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-quejugamos}"
IMAGE="${IMAGE:-}"
BOOTSTRAP="${BOOTSTRAP:-1}"
STEAM_CC="${STEAM_CC:-ar}"
MEMORY="${MEMORY:-512Mi}"
# Every open SSE stream occupies one concurrency slot on the single instance. Idle sockets are cheap
# for Node, and with request-based billing cost depends on instance active time, not on concurrency.
CONCURRENCY="${CONCURRENCY:-1000}"
# Cloud Run maximum (60 min). SSE clients (EventSource) reconnect automatically when it is reached.
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-3600}"
# `--source` deploys push to this auto-created repo; prebuilt images go to the `quejugamos` repo.
AR_REPOS="${AR_REPOS:-cloud-run-source-deploy quejugamos}"
# Dedicated runtime identity with ZERO roles: the app calls no GCP APIs. The default compute service
# account often has Editor on the whole project, which a compromised container would inherit.
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-quejugamos-runtime}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEEP_IMAGES="${KEEP_IMAGES:-3}"

log() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_cli_and_auth() {
  command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found. See docs/DEPLOY-CLOUDRUN.md."
  [[ -n "${PROJECT_ID}" ]] || die "PROJECT_ID is not set and no default gcloud project is configured."
  gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
    || die "No active gcloud account. Run: gcloud auth login"
}

require_billing() {
  local billing_enabled
  billing_enabled="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)')"
  [[ "${billing_enabled}" == "True" ]] \
    || die "Billing is not enabled on ${PROJECT_ID}. Cloud Run needs it even within the free tier."
}

enable_apis() {
  log "Enabling required APIs (no-op if already enabled)"
  gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    iam.googleapis.com \
    --project="${PROJECT_ID}"
}

ensure_runtime_service_account() {
  if gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    return 0
  fi
  log "Creating runtime service account ${RUNTIME_SA} (no roles granted)"
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
    --project="${PROJECT_ID}" --display-name="Que Jugamos Cloud Run runtime (no permissions)"
}

deploy_service() {
  local artifact_flag
  if [[ -n "${IMAGE}" ]]; then artifact_flag="--image=${IMAGE}"; else artifact_flag="--source=."; fi
  log "Deploying ${SERVICE} to ${REGION} (project ${PROJECT_ID}) with ${artifact_flag}"
  # --cpu-throttling   = request-based billing: billed only while a request (incl. an open SSE
  #                      stream) is in flight. Cheapest for a service that is idle most of the month.
  # --max-instances=1  = in-memory state requires exactly one instance; also caps worst-case cost.
  # --cpu=1            = minimum allowed when concurrency > 1 (sub-1 vCPU forces concurrency=1).
  gcloud run deploy "${SERVICE}" \
    "${artifact_flag}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
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
    --service-account="${RUNTIME_SA}" \
    --labels="app=quejugamos" \
    --quiet
}

# Every deploy pushes a new image and Artifact Registry's free tier is only 0.5 GB/month.
apply_image_cleanup_policies() {
  local policy_file repo
  policy_file="$(mktemp)"
  # shellcheck disable=SC2064  # expand now: the local var no longer exists when the trap fires.
  trap "rm -f '${policy_file}'" RETURN
  cat >"${policy_file}" <<EOF
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": ${KEEP_IMAGES}}},
  {"name": "delete-old", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}}
]
EOF
  for repo in ${AR_REPOS}; do
    if ! gcloud artifacts repositories describe "${repo}" \
        --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
      continue
    fi
    log "Cleanup policy on ${repo}: keep the ${KEEP_IMAGES} most recent images"
    gcloud artifacts repositories set-cleanup-policies "${repo}" \
      --project="${PROJECT_ID}" --location="${REGION}" \
      --policy="${policy_file}" --no-dry-run --quiet
  done
}

smoke_test() {
  local url
  url="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
  log "Smoke test: ${url}/healthz"
  curl --fail --silent --show-error --max-time 30 --retry 3 --retry-delay 2 "${url}/healthz"
  printf '\n\nDeployed: %s\n' "${url}"
}

main() {
  require_cli_and_auth
  if [[ "${BOOTSTRAP}" == "1" ]]; then
    require_billing
    enable_apis
    ensure_runtime_service_account
  fi
  deploy_service
  if [[ "${BOOTSTRAP}" == "1" ]]; then
    apply_image_cleanup_policies
    log "Budget alert not created yet? Run: PROJECT_ID=${PROJECT_ID} ./scripts/setup-budget.sh"
  fi
  smoke_test
}

main "$@"
