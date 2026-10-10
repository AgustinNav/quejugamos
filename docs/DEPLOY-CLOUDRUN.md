# ¿Qué Jugamos? — Deploy alternativo en Cloud Run

**Fecha:** 2026-10-09 · **Versión:** 1.0 · **Audiencia:** Agus (owner)
**Objetivo:** plan B si Render free deja de alcanzar. **Requiere tarjeta: USD 0 esperado, no garantizado** (peor caso ~USD 60/mes). El deploy principal es Render: ver `docs/DEPLOY.md`.

**Objetivo original:** llevar ¿Qué Jugamos? a Cloud Run a USD 0/mes, con guardrails de costo, en ~30 minutos.

## TL;DR

```bash
gcloud auth login
export PROJECT_ID=quejugamos-<sufijo> REGION=us-central1
gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account=<ID>
./scripts/setup-budget.sh       # alerta de USD 1 ANTES del primer deploy
./scripts/deploy-cloudrun.sh    # build + deploy + smoke test de /healthz
```

Por qué Cloud Run y no otro proveedor: `docs/HOSTING-COSTS.md`.

## Qué deja armado el script

| Flag | Valor | Por qué |
|---|---|---|
| `--cpu-throttling` | billing request-based | Se paga solo con requests en curso. Un SSE abierto cuenta como request |
| `--max-instances` / `--min-instances` | 1 / 0 | Estado en memoria ⇒ una sola instancia. Escala a cero sin costo |
| `--cpu` / `--memory` | 1 / 512Mi | Con menos de 1 vCPU, Cloud Run obliga a concurrency 1, y eso es incompatible con SSE |
| `--concurrency` | 1000 | Cada stream SSE ocupa un slot. No cambia el costo |
| `--timeout` | 3600 | El máximo. `EventSource` reconecta solo al cortarse |
| `--set-env-vars` | `TRUST_PROXY=1,STEAM_CC=ar` | IP real desde `X-Forwarded-For` detrás del front end de Google |
| `--service-account` | `quejugamos-runtime@…` sin roles | La app no usa APIs de GCP. La SA default suele tener rol Editor |
| Cleanup policy en Artifact Registry | Conserva las últimas 3 imágenes | El free tier es de 0,5 GB |

---

## 1. Instalar gcloud en Windows

Elegí una opción:

- **A. Cloud Shell (sin instalar nada).** Abrí <https://shell.cloud.google.com>, que ya trae `gcloud`, `docker` y `git`, y corré:
  `git clone <tu repo> && cd quejugamos`. Los scripts andan tal cual.
- **B. Local.** En PowerShell, corré `winget install -e --id Google.CloudSDK`, o bajá el instalador de <https://cloud.google.com/sdk/docs/install>. Después abrí **Git Bash** (los scripts son bash) y verificá con `gcloud version`.

```bash
gcloud auth login                 # abre el navegador
gcloud config set project "$PROJECT_ID"   # opcional; los scripts también leen PROJECT_ID
```

## 2. Crear el proyecto y vincular billing

```bash
export PROJECT_ID=quejugamos-$RANDOM   # el ID es global y no se puede cambiar
gcloud projects create "$PROJECT_ID" --name="Que Jugamos"
gcloud billing accounts list          # copiá el ACCOUNT_ID (XXXXXX-XXXXXX-XXXXXX)
gcloud billing projects link "$PROJECT_ID" --billing-account=<ACCOUNT_ID>
```

> Cloud Run exige una billing account aunque no salgas del free tier. Si es una cuenta nueva, el Free Trial (USD 300 / 90 días) **no se convierte solo en pago**: hay que hacer upgrade manual. Cuando termina el trial, los servicios se detienen hasta que hagas ese upgrade.

## 3. Budget alert (antes del primer deploy)

```bash
PROJECT_ID=$PROJECT_ID ./scripts/setup-budget.sh               # USD 1/mes por defecto
PROJECT_ID=$PROJECT_ID BUDGET_AMOUNT=5 ./scripts/setup-budget.sh   # otro monto
```

Avisa por mail al 50 %, 90 % y 100 % del gasto real, y al 100 % del **forecast**. Si tu billing account está en ARS, el script corta y te pide `BUDGET_AMOUNT` en esa moneda.

> **Un budget NO corta el gasto. Solo manda mails.** GCP no tiene tope duro.
> El techo real de esta app lo pone `--max-instances=1`: en el peor caso, 1 instancia prendida 24/7 cuesta ~USD 60/mes.

**Kill switch (opcional, no implementado):** budget → Pub/Sub → Cloud Run function que **desvincula el billing** del proyecto. Guía oficial: <https://docs.cloud.google.com/billing/docs/how-to/disable-billing-with-notifications>. Ojo: apaga **todo** el proyecto, puede borrar recursos, y la recuperación es manual. Además, las notificaciones llegan con demora, así que el gasto puede pasar el umbral igual. Para una app de USD 0 alcanza con la alerta y mirar el mail. El kill switch tiene sentido si viralizás y no vas a estar atento.

## 4. Primer deploy

```bash
PROJECT_ID=$PROJECT_ID REGION=us-central1 ./scripts/deploy-cloudrun.sh
```

El script:

1. Valida gcloud, la sesión y el billing.
2. Habilita las APIs `run`, `cloudbuild`, `artifactregistry` e `iam`.
3. Crea la SA de runtime sin permisos.
4. Corre `gcloud run deploy --source .`: Cloud Build construye el `Dockerfile` y Cloud Run publica una revisión nueva con el 100 % del tráfico.
5. Aplica la cleanup policy.
6. Hace `curl /healthz` contra la URL `https://quejugamos-xxxx.us-central1.run.app`.

Es idempotente: re-ejecutarlo equivale a "deployar la versión actual".

Variables opcionales: `REGION`, `SERVICE`, `STEAM_CC`, `MEMORY`, `CONCURRENCY`, `REQUEST_TIMEOUT`, `IMAGE` (deployar una imagen ya construida en vez de `--source`).

## 5. Dominio propio (opcional)

| Opción | Costo | SSE | Veredicto |
|---|---|---|---|
| URL `*.run.app` | 0 | OK | **Usar esta** salvo que el dominio sea parte del marketing |
| Cloud Run domain mapping | 0 (solo el dominio) | OK | Preview y "no recomendado para producción" según Google, pero disponible en `us-central1`. Alcanza para este proyecto |
| Firebase Hosting rewrite | Free tier | **Riesgoso.** Hasta donde sé, los rewrites a Cloud Run tienen timeout de 60 s (no lo verifiqué en esta sesión) | Evitar para `/events` |
| Global external Load Balancer | **~USD 18+/mes** (forwarding rule) | OK | **No.** Rompe el objetivo de USD 0 |

```bash
gcloud domains verify midominio.com
gcloud beta run domain-mappings create --service quejugamos --domain play.midominio.com --region us-central1
# Crear en tu DNS los registros que imprime el comando. El certificado TLS se emite solo (puede tardar ~15–60 min).
```

## 6. Ver logs

La app escribe JSON a stdout con el campo `severity`. Cloud Logging lo parsea automáticamente, así que podés filtrar por nivel y por campos (`jsonPayload.roomCode`).

```bash
# Últimos errores/warnings del día
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="quejugamos" AND severity>=WARNING' \
  --project "$PROJECT_ID" --freshness=1d --limit=50

# Eventos de una sala
gcloud logging read 'resource.labels.service_name="quejugamos" AND jsonPayload.roomCode="ABC234"' --project "$PROJECT_ID" --limit=100
```

En la consola: Cloud Run → `quejugamos` → **Logs** / **Metrics**. Para controlar costos, la métrica clave es **Billable container instance time**.

## 7. Rollback

```bash
gcloud run revisions list --service quejugamos --region us-central1 --project "$PROJECT_ID"
gcloud run services update-traffic quejugamos --region us-central1 --project "$PROJECT_ID" \
  --to-revisions=quejugamos-00007-abc=100
# Volver a "siempre la última revisión" cuando el fix esté deployado:
gcloud run services update-traffic quejugamos --region us-central1 --project "$PROJECT_ID" --to-latest
```

> Mientras el tráfico esté fijado a una revisión, los deploys nuevos **no reciben tráfico** hasta que corras `--to-latest`. Todo rollback reinicia la instancia, así que **las salas en memoria se pierden**: hacelo fuera de una noche de votación.

## 8. Deploy desde GitHub Actions (opcional)

- `.github/workflows/ci.yml` corre en cada PR y en cada push a `main`: tests, build de la imagen, container `healthy`, `curl /healthz` y verificación de que frena limpio con SIGTERM.
- `.github/workflows/deploy.yml` es **manual** (`workflow_dispatch`): tests → build + smoke → push a Artifact Registry → `scripts/deploy-cloudrun.sh` con `IMAGE=…`. Autentica con **Workload Identity Federation**, así que no hay JSON keys en GitHub.

Setup único (corré esto en Git Bash o Cloud Shell; `REPO` = `usuario/quejugamos`):

```bash
export PROJECT_ID=... REGION=us-central1 REPO=usuario/quejugamos
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
DEPLOYER=gh-deployer@$PROJECT_ID.iam.gserviceaccount.com
RUNTIME=quejugamos-runtime@$PROJECT_ID.iam.gserviceaccount.com   # lo crea deploy-cloudrun.sh

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"
gcloud artifacts repositories create quejugamos --repository-format=docker --location="$REGION" --project "$PROJECT_ID"

# Pool + provider OIDC. Solo acepta tokens de TU repo y de la rama main.
gcloud iam workload-identity-pools create github --location=global --project "$PROJECT_ID"
gcloud iam workload-identity-pools providers create-oidc quejugamos-repo \
  --location=global --workload-identity-pool=github --project "$PROJECT_ID" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'"

# Identidad de deploy con permisos mínimos
gcloud iam service-accounts create gh-deployer --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOYER" --role=roles/run.admin
gcloud artifacts repositories add-iam-policy-binding quejugamos --location="$REGION" --project "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER" --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project "$PROJECT_ID" \
  --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project "$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

En GitHub → Settings → Secrets and variables → Actions → **Variables** (no secrets: ninguna da acceso por sí sola):

| Variable | Valor |
|---|---|
| `GCP_PROJECT_ID` | `$PROJECT_ID` |
| `GCP_REGION` | `us-central1` |
| `GCP_WIF_PROVIDER` | `projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/quejugamos-repo` |
| `GCP_DEPLOY_SA` | `$DEPLOYER` |

Opcional: en Settings → Environments → `production`, agregá "Required reviewers" para que cada deploy pida tu aprobación.

## 9. Checklist de guardrails de costo

- [ ] Budget creado (`setup-budget.sh`) y el mail de alerta llega a una casilla que leés.
- [ ] `max-instances = 1` y `min-instances = 0`: verificar con `gcloud run services describe quejugamos --region us-central1 --format='yaml(spec.template.metadata.annotations)'`.
- [ ] Billing **request-based** (`run.googleapis.com/cpu-throttling: 'true'`).
- [ ] Región Tier 1 (`us-central1`).
- [ ] Sin Load Balancer, sin Cloud SQL, sin min-instances > 0, sin VPC connector.
- [ ] Cleanup policy en Artifact Registry (`gcloud artifacts repositories list-cleanup-policies cloud-run-source-deploy --location us-central1`).
- [ ] Una vez por mes: Billing → Reports filtrado por el proyecto. Tiene que dar USD 0,00.
- [ ] Backend: los streams SSE de salas expiradas se cierran y `/events` de una sala inexistente responde 4xx (si no, una pestaña olvidada factura 24/7).

## 10. Alternativa: Render (free, sin tarjeta)

Usala si preferís riesgo de factura cero a cambio de cold starts de ~1 min y salas que se pierden si Render reinicia el servicio (ver `HOSTING-COSTS.md`).

1. Subí el repo a GitHub y entrá a <https://dashboard.render.com> → **New → Web Service** → conectá el repo.
2. Runtime: **Docker** (usa el mismo `Dockerfile`). Instance type: **Free**. Región: la más cercana (p. ej. Ohio u Oregon).
3. Environment: `TRUST_PROXY=1`, `STEAM_CC=ar`. `HOST=0.0.0.0` ya viene en la imagen y Render inyecta `PORT`, que la app lee.
4. Advanced → Health Check Path: `/healthz`.
5. **No cargues método de pago.** Sin tarjeta, al pasarte del límite Render suspende el servicio en vez de cobrar.

Pendiente de validar en Render: si un SSE abierto evita el spin-down de 15 min, y el formato de `X-Forwarded-For` de su proxy (afecta al rate limit con `TRUST_PROXY=1`).
