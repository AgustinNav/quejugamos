# CLAUDE.md — ¿Qué Jugamos?

Proyecto derivado del Master (`~/.claude/CLAUDE.md`, ya cargado en cada sesión). Acá va solo lo específico de este repo.

**Producto:** salas efímeras donde un grupo vota juegos cooperativos desde el celular (QR + swipe) hasta que hay match. Sin cuentas, sin monetización.
**Estado:** v2 (salas en vivo con SSE) terminada. Deploy target: Render free vía `render.yaml`; Agus todavía no lo deployó.
`PLAN.md` es histórico (nombre GameMatch, Cloud Run como target): las decisiones vigentes están en este archivo y en `docs/`.

## Restricciones duras

Cada una existe por una razón concreta. Si una tarea choca con alguna, pará y preguntá.

### Costo: USD 0 garantizado
- Hosting = Render free **sin medio de pago cargado**: sin tarjeta, Render suspende en vez de cobrar. Es garantía, no estimación (decisión de Agus, `docs/HOSTING-COSTS.md`).
- Toda propuesta que cueste plata (tarjeta, dominio, plan pago, servicio externo) se marca explícitamente como "cuesta plata" antes de recomendarla.
- Cloud Run (`docs/DEPLOY-CLOUDRUN.md`, `scripts/*cloudrun*`, `.github/workflows/deploy.yml`) es plan B: requiere tarjeta y no tiene tope duro de gasto.

### Runtime: Node 24, TypeScript sin build, cero dependencias
- `node src/server.ts` corre con type stripping nativo: solo sintaxis TS borrable (sin `enum`, `namespace`, parameter properties), imports con extensión `.ts`. No hay build step ni `node_modules` en runtime, y el `Dockerfile` depende de eso.
- Type stripping **no type-checkea**: un error de tipos llega a producción como `ReferenceError`. Por eso existe `npm run typecheck` (`tsc --noEmit`) y corre en CI.
- Una dependencia nueva de runtime es una decisión de arquitectura: proponela con justificación, nunca la agregues de pasada. Las devDependencies (p. ej. `typescript`) están ok.

### Estado en memoria → exactamente una instancia
- Las salas viven en un `Map` en el proceso (`src/rooms.ts`). Dos instancias = salas partidas. Nunca escalar horizontalmente sin antes mover el estado (Redis o Durable Objects, fuera de alcance).
- Un reinicio, deploy o spin-down de Render borra todas las salas. El frontend lo muestra como "La sala se cerró": es comportamiento esperado, no bug.
- SSE no cuenta como tráfico entrante para Render: `public/js/keepalive.js` hace ping cada 4 min con la pestaña visible. No lo saques.

### Contrato API
`docs/API.md` es la fuente de verdad backend↔frontend (y `tools/mock-server.mjs` lo implementa). Cambiar el contrato = backend + frontend + mock + doc en el mismo PR. Un lado solo rompe al otro en silencio.

### Seguridad (ya establecida, no regresionar)
- CSP estricta sin `'unsafe-inline'` (`src/server.ts`): nada de `<script>`/`<style>` inline ni atributos `style=`/`onclick=`. Estilos dinámicos vía CSSOM (`el.style.x = ...`).
- Cero scripts de CDN: `script-src 'self'`. Las libs se vendorizan en `public/vendor/` con su licencia al lado (`qrcode.js`, `hls.min.js` + `hls.LICENSE`), verificando el hash contra el SRI publicado. Un origen nuevo en el CSP necesita justificación. `worker-src blob:` existe porque hls.js crea su worker desde un Blob.
- Límites por cliente siempre con la key de `rateLimitKey()` (IPv6 → su /64), nunca con la IP cruda: un usuario IPv6 tiene 2^64 direcciones.
- Toda escritura a un stream SSE pasa por `SseHub` (chequea `writableLength`): escribir directo a un `res` de SSE reabre el OOM por clientes que no leen.
- Todo parse de input externo (JSON, URL, params, headers, respuesta de Steam) va en try/catch y responde 4xx: un input malformado nunca tumba el proceso, porque una sola instancia caída = todas las salas perdidas.
- Tokens (`hostToken`, `playerToken`) nunca en logs, snapshots ni eventos SSE.
- IP del cliente solo vía `TRUSTED_PROXY_HOPS` (entrada N desde la derecha de `X-Forwarded-For`). Leer el header directo permite falsificar la IP y saltear el rate limit.
- El proxy de Steam solo acepta `steamId` de `public/games.js` (allowlist).

### Marca
- Nunca "Tinder" en copy, docs, metadata ni marketing: es marca registrada. Describí la mecánica ("deslizá", "swipe", "match").
- Nombre: "¿Qué Jugamos?". Slug (repo, servicio, imagen, prefijo de storage): `quejugamos`. "GameMatch" fue descartado por colisión con gamematch.app.

### Git
- Feature branch → merge a `main` con `--no-ff`. Conventional commits.
- Autor de commits = el noreply de GitHub ya configurado en el repo. Nunca el mail personal de Agus: el repo es público.
- `.claude/worktrees/` está en `.gitignore`. Antes de `git add`, mirá `git status`; `git add -A` sin revisar mete los worktrees de agentes como gitlinks.

## Comandos

| Qué | Comando |
|---|---|
| Correr local | `npm start` → http://localhost:3000 (`HOST=0.0.0.0` para probar con celulares en la LAN) |
| Tests | `npm test` (`node:test`; los de HTTP levantan el server real vía `test/helpers.ts`) |
| Type-check | `npm run typecheck` |
| Mock del backend para frontend | `node tools/mock-server.mjs` → puerto 3100. Endpoints `/__mock/...` para bots, expirar sala y cortar SSE (ver header del archivo) |
| Smoke de Docker (igual que CI) | `./scripts/docker-smoke.sh [tag]` |
| Regenerar OG image | `msedge --headless --disable-gpu --hide-scrollbars --window-size=1200,630 --screenshot=public/og-image.jpg tools/og-image.html` |

Env vars: tabla en `README.md`.

## Dónde está lo no obvio

| Path | Por qué importa |
|---|---|
| `public/games.js` | Catálogo curado + allowlist del proxy de Steam. Plataformas y crossplay cargados a mano |
| `src/config.ts` | Parse de env (`TRUSTED_PROXY_HOPS`, `LOG_PROXY_HEADERS`) |
| `public/js/store.js` | Tokens por sala en `localStorage['quejugamos:room:<CODE>']` |
| `render.yaml` | Deploy real. `autoDeployTrigger: checksPass` → Render solo deploya con CI verde |
| `docs/DEPLOY.md` §4 | Procedimiento de calibración de `TRUSTED_PROXY_HOPS` |

## Verificación antes de decir "listo"

1. `npm test` y `npm run typecheck` en verde.
2. Endpoint nuevo o modificado → test de integración con input malformado (JSON roto, body > 1 KB, content-type incorrecto, token ajeno, código inexistente) que verifique 4xx **y** que el proceso sigue vivo.
3. Código detrás de un flag de config → un test que lo active (ver Mistakes Log).
4. Cambio de UI → server real (`npm start`, no solo el mock) + browser: host en desktop y jugador en 375px de ancho, en **dos orígenes distintos** (p. ej. `localhost:3000` y `127.0.0.1:3000`) para que no compartan `localStorage` y se pisen los tokens. Revisar la consola: una violación de CSP es un bug.
   - **Browser: avisar antes, visible y siempre muted.** Nunca abrir una sesión de browser (pane integrado o Chrome, propia o de un subagente) sin avisarle a Agus en el chat; abierta, tiene que quedar visible. Todo `<video>`/`<audio>` va silenciado: el volumen se verifica leyendo `muted`/`volume`, nunca reproduciendo audio. Al terminar, pausar y cerrar las pestañas. Todo prompt de subagente que pueda usar un browser incluye esta regla.
5. Cambio en `Dockerfile` o arranque → `./scripts/docker-smoke.sh`.

## Riesgos abiertos

- **`X-Forwarded-For` en Render calibrado (2026-10-12): `TRUSTED_PROXY_HOPS=3`.** Formato observado: `[cliente, IP de Cloudflare, IP interna 10.x de Render]`; un XFF falsificado por el cliente queda a la izquierda y no cambia la 3ª desde la derecha. Con 1 se leía la IP interna, que cambia por request, y el rate limit por cliente no frenaba nada. Si Render cambia su topología de proxies, hay que recalibrar (`docs/DEPLOY.md` §4). El Blueprint está en sync manual: las env vars se cambian a mano en el dashboard.
- **Homoglyphs en nombres:** se rechazan invisibles y fillers, pero no se detectan look-alikes entre scripts (Cyrillic `а` vs Latin `a`). Solución completa = esqueletos de confusables (UTS #39), fuera de alcance.
- **Steam `appdetails` no está documentado** por Valve: puede cambiar o empezar a limitar sin aviso. Cache de 6 h; fallas → 502, nunca crash.
- **Crossplay/plataformas cargados a mano**: los marcados "verificar" no están confirmados.
- **Rate limits vs lanzamiento viral**: 500 salas totales y 5/IP/hora. Una oficina o un NAT de carrier comparten IP.
- **Cold start ~1 min** tras 15 min sin tráfico (Render free). Mitigación UX: abrir el link antes de la juntada.

## Mistakes Log del proyecto

Lecciones universales van al Master, no acá.

- **2026-10-12 — Trailers sonando por los parlantes de Agus.** Subagentes que probaban la galería abrieron pestañas ocultas y reprodujeron trailers con audio; Agus tuvo que preguntar de dónde venía el sonido y pedir que se cerraran todas. **Regla:** browser solo avisando antes, visible y con todo el media muted (ver Verificación §4).
- **2026-10-09 — `log()` indefinido detrás de `LOG_PROXY_HEADERS`.** Con el flag en `1`, crear una sala daba 500 por `ReferenceError`; type stripping no lo detectó y ningún test activaba el flag (`fbdd689`). **Regla:** todo flag de config tiene un test que lo enciende; los loggers se inyectan, no se referencian globales; `npm run typecheck` en CI.
- **2026-10-09 — Worktrees de agentes commiteados como gitlinks.** `git add -A` sumó `.claude/worktrees/*` como submódulos rotos. **Regla:** `.claude/worktrees/` en `.gitignore` y `git status` antes de cada `git add`.
- **2026-10-09 — Jugadores tardíos rompían matches pasados.** El ranking se recalculaba con la cantidad actual de jugadores, así que alguien que entraba después convertía un match en no-match (`3448ecc`). **Regla:** los resultados de una carta se congelan al cerrarse (`results` en el snapshot); el frontend nunca recalcula desde `votes`.
- **2026-10-09 — Rate limit perdía el registro de creación.** El sweep de capacidad podaba la entrada de la IP antes de registrar la sala nueva (`3687306`). **Regla:** registrar el efecto después de cualquier limpieza que toque la misma estructura, y testear el límite en el borde.
- **2026-10-09 — Smoke test de stop medido por tiempo.** Chequear el SIGTERM por duración era flaky; se pasó a fallar por exit code 137 (SIGKILL) (`7462152`). **Regla:** en checks de CI, aserciones sobre señales observables (exit code, status), no sobre tiempos de reloj.
