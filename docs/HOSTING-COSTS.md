# GameMatch — Dónde hostear y cuánto cuesta

**Fecha de relevamiento:** 2026-10-09 · **Autor:** Claude (agente infra) para Agus · **Versión:** 1.0
**Audiencia:** Agus (decisión de hosting) · **Objetivo:** elegir el hosting más barato con el menor riesgo de factura sorpresa para una app de 1 instancia con SSE.

## TL;DR

- **Recomendación: Google Cloud Run, billing request-based, `us-central1`, `max-instances=1`.** Costo realista: **USD 0/mes**. El free tier cubre ~50 h/mes con al menos una conexión SSE abierta, y 20 noches × 2 h son 40 h.
- **Riesgo principal:** una conexión SSE abierta factura como tiempo activo. Una pestaña olvidada que reconecta sin parar, o un abuso que mantenga streams abiertos, factura 24/7. El techo teórico es **~USD 60/mes** (1 instancia × 720 h). `max-instances=1` acota ese techo, pero GCP **no tiene tope duro de gasto**: los budgets solo mandan alertas. La mitigación de fondo la hace el backend (ver "Riesgos").
- **Segunda opción: Render free.** USD 0 y **sin tarjeta**, así que el riesgo de factura es cero. El costo es otro: cold start de ~1 min, spin-down a los 15 min sin tráfico y reinicios cuando Render quiera (se pierden las salas en memoria).
- Fly.io ya **no tiene free tier** para cuentas nuevas. Koyeb sí, pero pide tarjeta. Railway y Northflank tienen tiers gratis con datos que no pude verificar del todo.

## Perfil de la carga (supuestos)

| Parámetro | Valor |
|---|---|
| Instancias | Exactamente 1 (estado en memoria) |
| CPU / RAM | 1 vCPU (mínimo de Cloud Run con concurrency > 1) / 512 MiB |
| Tráfico | Bajo. ~20 noches de votación × 2 h × 3–12 conexiones SSE. Idle el resto del mes |
| Egress | Mínimo: trailers e imágenes vienen directo del CDN de Steam al navegador |
| Requisito técnico | Conexiones HTTP largas (SSE, ping cada 25 s) |

## Cloud Run: cómo se factura una conexión SSE

- **Request-based** (`--cpu-throttling`, default): se cobra solo mientras la instancia procesa al menos un request, más el arranque y el apagado. Un stream SSE abierto **es** un request en curso, así que el tiempo facturado es el tiempo con ≥1 conexión abierta. 10 conexiones simultáneas cuestan lo mismo que 1, porque se factura por instancia y no por request.
- **Instance-based** (`--no-cpu-throttling`): se cobra todo el ciclo de vida de la instancia, idle incluido. Exige ≥ 512 MiB.

| Concepto (Tier 1, ej. us-central1) | Request-based | Instance-based |
|---|---|---|
| Free tier CPU | 180.000 vCPU-s/mes | 240.000 vCPU-s/mes |
| Free tier memoria | 360.000 GiB-s/mes | 450.000 GiB-s/mes |
| Free tier requests | 2 M/mes | n/a (no cobra por request) |
| Precio CPU | USD 0,000024 / vCPU-s | USD 0,000018 / vCPU-s |
| Precio memoria | USD 0,0000025 / GiB-s | USD 0,000002 / GiB-s |
| Requests | USD 0,40 / millón | — |

Los números de free tier request-based salen de la página oficial de free tier de Google. Los de instance-based y los precios unitarios salen de snippets de la página de pricing de Cloud Run; no pude cargar la página completa con mi herramienta. **Verificá en <https://cloud.google.com/run/pricing> antes de decidir.**

### Escenarios (1 vCPU, 0,5 GiB, request-based)

| Escenario | Tiempo activo | CPU facturable | Memoria facturable | Costo/mes |
|---|---|---|---|---|
| Realista: 20 noches × 2 h | 40 h = 144.000 s | 0 (< 180.000) | 0 (72.000 < 360.000) | **USD 0** |
| Intenso: 60 h/mes | 216.000 s | 36.000 × 0,000024 | 0 | **~USD 0,86** |
| Peor caso: ≥1 SSE abierto 24/7 | 720 h = 2.592.000 s | 2.412.000 × 0,000024 = 57,89 | 936.000 × 0,0000025 = 2,34 | **~USD 60** (techo por `max-instances=1`) |

### ¿Por qué request-based y no instance-based?

Instance-based tiene más free tier y un peor caso más barato (~USD 44/mes 24/7). Lo descarto por cómo se comporta con tráfico esporádico. Cada vez que algo despierta la instancia (un curioso que abre la landing después del TikTok, un bot, un health check externo), instance-based factura la instancia **idle hasta que Cloud Run la apaga, que puede tardar hasta ~15 min**. Request-based factura ese mismo hit en milisegundos. Con 30 despertares por día, instance-based ronda las 225 h/mes y **~USD 10/mes**. Para una app "idle casi siempre, con picos", request-based es la opción correcta.

## Comparativa de proveedores

| Proveedor | Costo/mes estimado | ¿Tarjeta? | ¿Tope duro? | Cold start | SSE / conexiones largas | Timeout de request | Ops |
|---|---|---|---|---|---|---|---|
| **Cloud Run** (request-based) | **USD 0** realista; techo ~USD 60 | Sí (billing account obligatoria) | **No.** Los budgets alertan, no cortan. El techo práctico lo pone `max-instances=1` | Segundos (imagen Alpine chica) | Sí. Una conexión abierta mantiene viva la instancia | Default 300 s, máx. 3600 s. El cliente reconecta | Muy bajo: HTTPS, logs y revisiones gestionados |
| **GCE e2-micro** (always free) | VM USD 0. **IPv4 externa ~USD 3,65** (0,005/h), *no verifiqué si el free tier la exime* | Sí | No | Ninguno (VM siempre prendida) | Sí, sin límites | Sin límite (lo controlás vos) | **Alto**: parches del SO, TLS (Caddy), systemd, firewall. 1 GB RAM |
| **Render** free | **USD 0** | **No** para free. Sin método de pago, al pasarte se suspende en vez de cobrar | **Sí, de hecho** (sin tarjeta no hay a quién cobrarle) | **~1 min** después de 15 min sin tráfico entrante | WebSockets soportados. Sobre SSE no hay mención explícita. **No verifiqué** si un SSE abierto cuenta como "tráfico entrante" para evitar el spin-down | No documentado en las páginas que revisé | Bajo. Ojo: "Render puede reiniciar free services en cualquier momento" → salas perdidas |
| **Koyeb** free | USD 0 ("nunca se cobra el free web Service") | **Sí** (pre-autorización de USD 29 que se cancela) | Sí, para el free service | Scale-to-zero tras ~1 h idle (dato de terceros, no del sitio oficial) | No verificado | No verificado | Bajo. Solo Frankfurt o Washington D.C. 512 MB / 0,1 vCPU. Koyeb fue adquirida por Mistral AI en 2026 (fuente de terceros): riesgo de cambios de plan |
| **Fly.io** | Sin free tier. shared-cpu-1x 256 MB = USD 2,19/mes y 512 MB = USD 3,69/mes 24/7. Con auto-stop se paga solo el tiempo prendido + rootfs a USD 0,15/GB-mes | Sí, después del trial (2 h de máquina o 7 días) | No verificado | Auto-start en ~segundos (no medido) | No verificado en las páginas revisadas | No verificado | Bajo-medio (`fly.toml`, CLI) |
| **Railway** | Plan Free: USD 0 con USD 1/mes de crédito, máx. 0,5 GB/servicio. 0,5 GB 24/7 ≈ USD 5 → **no alcanza para always-on**. Hobby USD 5/mes | Trial sin tarjeta. Hobby con tarjeta | No mencionado en pricing | Depende de "app sleeping", que **no pude confirmar** en la página de pricing | No verificado | No verificado | Bajo |
| **Northflank** Sandbox | USD 0 (2 servicios free, "always-on, no sleeping") | **No verificado** | No mencionado | Ninguno (always-on) | No verificado | No verificado | Bajo. Specs del sandbox no publicados ("Limited"). El plan más chico pago es nf-compute-10 (0,1 vCPU / 256 MB) a USD 2,70/mes |

## Recomendación

1. **Cloud Run request-based en `us-central1`** con `--max-instances=1 --min-instances=0 --cpu=1 --memory=512Mi --concurrency=1000 --timeout=3600 --cpu-throttling`. Está implementado en `scripts/deploy-cloudrun.sh`.
   - Gana porque: USD 0 realista, HTTPS y dominio `*.run.app` gratis, cero servidores que mantener, revisiones con rollback instantáneo, y le suma al CV para MeLi (Docker + CI/CD + WIF + observabilidad).
   - `us-central1` porque es Tier 1 (precio más bajo, free tier completo) y es una de las regiones del always-free de GCE. La latencia desde Argentina es de ~150–200 ms (estimación, no medida). Alcanza para votar.
2. **Budget alert de USD 1** (`scripts/setup-budget.sh`) **antes** del primer deploy. Opcional: kill switch (ver `docs/DEPLOY.md`).
3. **Plan B: Render free** si el requisito pasa a ser "no quiero dar tarjeta" o "riesgo de factura = 0 garantizado". Se acepta el cold start de ~1 min y la posibilidad de perder salas por reinicio.

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| SSE abierto indefinidamente (pestaña olvidada o abuso que crea salas cada 2 h) | Hasta ~USD 60/mes | **Backend:** cerrar los streams cuando expira la sala; responder **404/204** en `/events` de salas inexistentes, porque `EventSource` deja de reconectar ante un status ≠ 200. La actividad de la sala (TTL) la definen join/vote, **nunca** la conexión SSE. **Infra:** budget alert + revisar la métrica "billable instance time" en Cloud Monitoring |
| GCP no tiene tope duro de gasto | Factura antes de que reacciones | Budget con umbral sobre el gasto *forecasted*. Kill switch opcional (deshabilita billing → baja el servicio) |
| Cambian los precios o el free tier | Costos distintos | Relevar de nuevo cada 6 meses. Este documento lleva fecha |
| Artifact Registry > 0,5 GB free (una imagen por deploy) | Centavos | Cleanup policy "keep 3" que aplica `deploy-cloudrun.sh` |
| Dominio custom con Load Balancer | **~USD 18+/mes** de forwarding rules | No usar un LB. Usar domain mapping de Cloud Run o Firebase Hosting (ver DEPLOY.md) |
| Scale-to-zero borra las salas sin conexiones | UX | Aceptado en PLAN.md (las salas son de una noche) |

## Lo que no pude verificar (no bluffeo)

- Los precios unitarios y el free tier instance-based de Cloud Run salen de snippets de búsqueda de la página oficial (no cargó completa).
- La contradicción de la doc de timeout de Cloud Run: dice "hasta 60 minutos (3600 s)" y también "debe ser menor a 60 minutos". Si `--timeout=3600` falla, usar `3599`.
- Si la IPv4 externa de una e2-micro free tier se cobra o está exenta: la página de pricing de IPs no menciona exención.
- En Render: specs de RAM/CPU del plan free, timeout máximo de request, y si un SSE abierto evita el spin-down.
- Koyeb: período de idle antes de scale-to-zero y el dato de la adquisición (ambos de fuentes de terceros).
- Railway "app sleeping" y Northflank (tarjeta y specs del sandbox).

## Fuentes (consultadas 2026-10-09)

- Cloud Run pricing: <https://cloud.google.com/run/pricing> (los snippets de búsqueda incluyen copias localizadas, p. ej. <https://cloud.google.com/run/pricing?hl=nl>)
- Google Cloud Free Tier (Cloud Run request-based, e2-micro, Artifact Registry 0,5 GB, Cloud Build 2.500 min): <https://docs.cloud.google.com/free/docs/free-cloud-features>
- Cloud Run billing settings (request vs instance, flags, ≥512 MiB): <https://docs.cloud.google.com/run/docs/configuring/billing-settings>
- Cloud Run request timeout (300 s default, 3600 s máx.): <https://docs.cloud.google.com/run/docs/configuring/request-timeout>
- Cloud Run CPU limits (< 1 vCPU ⇒ concurrency 1 + request-based): <https://docs.cloud.google.com/run/docs/configuring/services/cpu>
- Cloud Run WebSockets / conexiones largas (instancia activa mientras haya conexión abierta): <https://docs.cloud.google.com/run/docs/triggering/websockets>
- Precio IPv4 externa en GCE: <https://cloud.google.com/vpc/pricing-announce-external-ips>
- Artifact Registry cleanup policies: <https://docs.cloud.google.com/artifact-registry/docs/repositories/cleanup-policy>
- gcloud billing budgets create: <https://docs.cloud.google.com/sdk/gcloud/reference/billing/budgets/create>
- Render free: <https://render.com/docs/free>
- Fly.io pricing: <https://docs.fly.io/about/pricing>
- Koyeb pricing FAQ: <https://www.koyeb.com/docs/faqs/pricing>. Terceros sobre idle de 1 h y adquisición por Mistral: <https://snapdeploy.dev/blog/koyeb-vs-free-container-tier>
- Railway pricing: <https://railway.com/pricing>
- Northflank pricing: <https://northflank.com/pricing>
