#!/usr/bin/env bash
# Create a monthly budget alert scoped to the Que Jugamos project. Idempotent (skips if it exists).
#
# IMPORTANT: a GCP budget only SENDS EMAILS. It does NOT stop or cap spending. The hard stop is the
# optional "kill switch" (budget -> Pub/Sub -> function that disables billing), documented in
# docs/DEPLOY.md and not implemented here on purpose: it deletes the project's billing link, which
# takes the service down.
#
# Usage:
#   PROJECT_ID=my-project ./scripts/setup-budget.sh
#   PROJECT_ID=my-project BUDGET_AMOUNT=5 ./scripts/setup-budget.sh
#
# Requires the Billing Account Administrator (or Billing Account Costs Manager) role.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
BUDGET_NAME="${BUDGET_NAME:-quejugamos-monthly}"
BUDGET_AMOUNT_DEFAULT_USD="1"

log() { printf '\n==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI not found. See docs/DEPLOY.md."
[[ -n "${PROJECT_ID}" ]] || die "PROJECT_ID is not set and no default gcloud project is configured."

billing_account_id() {
  local name
  name="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingAccountName)')"
  [[ -n "${name}" ]] || die "Project ${PROJECT_ID} has no billing account linked."
  printf '%s' "${name#billingAccounts/}"
}

# The budget currency must match the billing account currency (e.g. an ARS account rejects "1USD").
resolve_amount() {
  local account="$1" currency
  currency="$(gcloud billing accounts describe "${account}" --format='value(currencyCode)')"
  if [[ -n "${BUDGET_AMOUNT:-}" ]]; then
    printf '%s%s' "${BUDGET_AMOUNT}" "${currency}"
  elif [[ "${currency}" == "USD" ]]; then
    printf '%sUSD' "${BUDGET_AMOUNT_DEFAULT_USD}"
  else
    die "Billing account currency is ${currency}. Set BUDGET_AMOUNT to the equivalent of USD ${BUDGET_AMOUNT_DEFAULT_USD} in ${currency}."
  fi
}

budget_exists() {
  local account="$1"
  gcloud billing budgets list --billing-account="${account}" --format='value(displayName)' \
    | grep -Fxq "${BUDGET_NAME}"
}

main() {
  log "Enabling the Budgets API on ${PROJECT_ID}"
  gcloud services enable billingbudgets.googleapis.com --project="${PROJECT_ID}"

  local account amount
  account="$(billing_account_id)"
  if budget_exists "${account}"; then
    log "Budget '${BUDGET_NAME}' already exists on billing account ${account}; nothing to do."
    return 0
  fi
  amount="$(resolve_amount "${account}")"

  log "Creating budget '${BUDGET_NAME}' = ${amount}/month for projects/${PROJECT_ID}"
  # Alerts at 50/90/100% of actual spend and at 100% of FORECASTED spend (earliest warning).
  # Default recipients = billing account admins/users (your Google account email).
  gcloud billing budgets create \
    --billing-account="${account}" \
    --display-name="${BUDGET_NAME}" \
    --budget-amount="${amount}" \
    --filter-projects="projects/${PROJECT_ID}" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=0.9 \
    --threshold-rule=percent=1.0 \
    --threshold-rule=percent=1.0,basis=forecasted-spend

  log "Done. Remember: this alerts, it does NOT cap spending."
}

main "$@"
