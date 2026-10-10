# GameMatch v2 — Plan de publicación

**Fecha:** 2026-10-09 · **Estado:** propuesto · **Audiencia:** sesión de ejecución (Claude) + Agus

## TL;DR
Pasar de "un host comparte pantalla" a **salas con link/QR donde cada amigo vota desde su celular**, en vivo. Deploy en **Cloud Run** (1 instancia, estado en memoria), gratis y sin monetizar. Promoción con un video de TikTok/Reels.

## Decisiones tomadas
| Tema | Decisión | Por qué |
|---|---|---|
| Votación | Salas con código + QR | Es el producto; screen-share es un workaround |
| Tiempo real | **SSE + POST** (no WebSocket) | Zero deps, reconexión nativa, HTTP puro sobre Cloud Run. Votos = pocos eventos cliente→server |
| Hosting | Cloud Run, `max-instances=1`, `min-instances=0` | HTTPS gratis, free tier, sin VM que mantener. 1 instancia = estado en memoria válido y techo de costo acotado |
| Estado | `Map` en memoria con TTL | Salas efímeras (una noche). Escalar = Redis → fuera de alcance |
| Monetización | Ninguna | Menor riesgo legal con assets de Steam; mejor recepción en comunidades |
| Lenguaje | **TypeScript con type-stripping nativo de Node 24** (`node server.ts`, sin build) | Tipos sin toolchain; alineado al estándar Node del CLAUDE.md |
| Marca | "GameMatch" provisorio. **Nunca "Tinder"** en copy/marketing | Marca registrada. Verificar disponibilidad del nombre antes del launch |

## Arquitectura

```
Host (TV/PC)                       Server (Cloud Run, 1 instancia)            Amigos (celular)
 POST /api/rooms ─────────────────▶ crea Room{code, hostToken, deck}
 GET  /api/rooms/:code/events (SSE) ◀── broadcast: state, vote, next, match ──▶ SSE
                                    ◀── POST /api/rooms/:code/join {name} ──── → playerToken
                                    ◀── POST /api/rooms/:code/vote {gameId, vote}  (Bearer playerToken)
 POST /api/rooms/:code/next (Bearer hostToken)
```

- **Room:** `code` (6 chars de alfabeto sin ambiguos `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, `crypto.randomInt`), `hostToken` y `playerToken` (`crypto.randomUUID`), `deck` mezclado en el server (todos ven el mismo orden), `index`, `votes`, `lastActivity`.
- **Vistas:** `/` crear sala → `/r/:code` (host: tarjeta grande + QR + quién votó) · `/r/:code` en celular (tarjeta compacta + 👍/👎 gigantes).
- **Avance:** auto cuando votan todos; el host puede forzar. Overlay de match broadcast a todos.
- **QR:** `qrcode-generator` desde cdnjs con SRI (generarlo a mano no vale la pena).

## Seguridad (además de lo ya aplicado)
- `JSON.parse` en try/catch + body limit 1 KB + `Content-Type: application/json` obligatorio en POST (regla 2026-10-09 del CLAUDE.md).
- Validación de nombres: trim, 1–16 chars, sin caracteres de control; únicos por sala.
- Acciones de host exigen `hostToken`; votos exigen `playerToken`. Tokens en `localStorage` por sala.
- Límites: 12 jugadores/sala, 500 salas totales, 5 salas creadas/IP/hora, TTL 2 h de inactividad, máx. 3 conexiones SSE por token.
- **Rate limit detrás de proxy:** leer IP de `X-Forwarded-For` solo con `TRUST_PROXY=1`. Verificar en docs de Cloud Run qué posición del header es confiable (el cliente puede inyectar entradas propias).
- CSP: agregar `cdnjs.cloudflare.com` a `script-src`. Mantener SRI en todo script externo.

## Tests (node:test, zero deps)
- **Unit — dominio Room:** crear, unirse (nombre duplicado/inválido/sala llena), votar (token inválido, juego que no es el actual, cambiar voto), avance automático, match unánime, expiración por TTL, límite global de salas.
- **Integración — HTTP:** cada endpoint con input malformado (JSON roto, body enorme, código inexistente, token ajeno, URL malformada) → 4xx y **proceso vivo**. SSE: recibe broadcast tras un voto.
- CI: GitHub Actions corre `node --test` en cada PR.

## Deploy
1. `Dockerfile`: `node:24-alpine`, usuario no-root, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `HEALTHCHECK`.
2. `gcloud run deploy gamematch --source . --region us-central1 --max-instances 1 --min-instances 0 --timeout 3600 --concurrency 100 --allow-unauthenticated`
3. **Antes del primer deploy:** budget alert de USD 1 en Billing. Verificar en la página de pricing de Cloud Run qué regiones cubre el free tier.
4. Riesgo conocido: con `min-instances=0`, una sala sin conexiones abiertas muere cuando la instancia escala a cero. Aceptable (las salas son de una noche); el SSE abierto mantiene viva la instancia.

## Observabilidad
Logs JSON estructurados (Cloud Logging los parsea): `room_created`, `player_joined`, `vote`, `match`, `room_expired`, errores con `roomCode`. Log-based metrics para salas/día y matches/sala.

## Fases
| Fase | Entregable | Verificación |
|---|---|---|
| F0 | Mover a `C:\dev\gamematch`, `git init`, repo GitHub público, migrar a `.ts` | `node server.ts` levanta, la app actual funciona igual |
| F1 | Dominio Room + endpoints + SSE | Tests unit + integración en verde |
| F2 | Vistas host/celular + QR | 3 navegadores (1 host + 2 "celulares" en viewport mobile) votando una sala completa |
| F3 | Docker + Cloud Run + budget alert | URL `*.run.app` funcionando desde un celular con 4G |
| F4 | Kit TikTok (abajo) + OG tags + favicon | Preview del link en Discord/WhatsApp se ve bien |

## F4 — Kit TikTok/Reels (Claude redacta, Agus publica)
- **Formato:** 15–25 s, vertical, hook en el primer segundo.
- **Guion base:** (0–2 s) texto: "Mi grupo tarda más en elegir el juego que en jugarlo" → (2–8 s) pantalla del host con QR, amigos escaneando → (8–18 s) swipes rápidos en varios celulares → (18–22 s) "IT'S A MATCH 💘" → (22–25 s) URL en pantalla.
- **Entregables:** 3 variantes de hook, caption, hashtags, y una lista de tomas para grabar.

## Fuera de alcance (v2)
Cuentas/login, catálogo dinámico desde Steam por tags, multi-instancia/Redis, Discord Activity, i18n.

## Próximo paso
Nueva sesión en `C:\dev\gamematch` con este archivo como contexto → F0.
