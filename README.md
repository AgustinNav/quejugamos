# ¿Qué Jugamos? 🎮💘

Elegí a qué jugar con tus amigos deslizando: el host crea una sala, cada uno entra desde el celular con un QR y vota 👍/👎 juegos cooperativos con trailer, precio y plataformas. Cuando a todos les gusta uno → **IT'S A MATCH**.

Gratis, sin cuentas, sin descargar.

## Correr local

```bash
npm start
```

Abrir http://localhost:3000. Node 24+ (corre TypeScript nativo, sin build), cero dependencias.

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto |
| `HOST` | `127.0.0.1` | `0.0.0.0` para exponer en la red / en un container |
| `STEAM_CC` | `ar` | Región de precios de Steam |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies que agregan entradas a `X-Forwarded-For` delante del server (`TRUST_PROXY=1` equivale a `1`). Ver `docs/DEPLOY.md` §4 |
| `LOG_PROXY_HEADERS` | `0` | `1` loguea `X-Forwarded-For` al crear una sala, para calibrar lo anterior |
| `PUBLIC_ORIGIN` | `https://quejugamos.onrender.com` | Origen público (sin path) para `canonical`, `og:url`, `og:image`, JSON-LD, `robots.txt` y `sitemap.xml`. Cambiar de dominio = cambiar solo esta variable. Inválido → default + WARNING `config_invalid` al arrancar |
| `GOOGLE_SITE_VERIFICATION` | — | Token de Google Search Console; inyecta `<meta name="google-site-verification">`. Debe matchear `^[A-Za-z0-9_-]{10,100}$`, si no se ignora con WARNING |
| `BING_SITE_VERIFICATION` | — | Token de Bing Webmaster Tools; inyecta `<meta name="msvalidate.01">`. Misma validación |

Para probar con celulares en la misma red: `HOST=0.0.0.0 npm start` y abrir `http://<ip-de-tu-pc>:3000`.

## Tests

```bash
npm test
```

`npm run typecheck` corre `tsc` (sin emitir nada): Node solo borra los tipos, no los chequea, así que esto lo corre CI antes de los tests. Requiere `npm ci` (dev deps únicamente; el runtime sigue sin dependencias).

`node:test` sobre el dominio de salas, el filtrado del mazo y el server HTTP real (incluye inputs malformados en cada endpoint).

## Estructura

| Path | Qué es |
|---|---|
| `src/` | Server: salas en memoria (`rooms.ts`), SSE (`sse.ts`), proxy de Steam con cache (`steam.ts`), HTTP/seguridad (`http.ts`, `server.ts`) |
| `public/` | Frontend vanilla JS: landing, vista host (QR + tarjeta grande) y vista celular |
| `public/games.js` | Catálogo curado. Para agregar un juego de Steam, sumá una entrada con su `steamId` |
| `docs/API.md` | Contrato de la API entre frontend y backend |
| `docs/DEPLOY.md` | Deploy en Render free (USD 0 garantizado). Plan B: `docs/DEPLOY-CLOUDRUN.md` |
| `docs/marketing/` | Kit de lanzamiento |
| `tools/mock-server.mjs` | Server simulado para desarrollar el frontend sin backend |

## Datos y límites

- Precio, trailer, capturas y reseñas vienen en vivo de Steam (cache de 6 h). Plataformas y crossplay están cargados a mano: los marcados "verificar" no están confirmados.
- Las salas viven en memoria: se pierden si el server se reinicia, expiran tras 2 h sin actividad, se borran a los 10 min de quedar sin nadie conectado y el host puede cerrarlas en el momento. Por eso corre en **una sola instancia**.
- Límites: 12 jugadores por sala, 500 salas activas, 5 salas creadas por IP por hora.

## Seguridad

Allowlist de juegos en el proxy de Steam, rate limit por IP, body JSON de máx. 1 KB, tokens por sala comparados en tiempo constante, CSP estricta (sin inline), SRI en scripts externos, y todo input malformado responde 4xx en vez de tumbar el proceso.

Proyecto independiente, sin relación con Valve/Steam ni con los publishers de los juegos.
