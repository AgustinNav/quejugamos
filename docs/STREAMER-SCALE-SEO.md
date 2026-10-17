# ¿Qué Jugamos? con un streamer: escala y SEO

**Fecha:** 2026-10-17 · **Autor:** Claude (análisis) para Agus · **Versión:** 1.0
**Audiencia:** Agus · **Objetivo:** decidir qué hay que cambiar antes de que un streamer mande miles de personas a la app, y cómo posicionarla en buscadores sin gastar plata.

## TL;DR

- **Lo primero que se rompe no es la CPU ni el rate limit: es el bandwidth.** Render free (workspace Hobby) incluye **5 GB/mes de salida**. Si se pasa y no hay tarjeta cargada, Render **apaga el servicio hasta el mes siguiente**. La garantía de USD 0 se cumple, pero la app queda muerta varias semanas.
- **El culpable es el SSE, no los visitantes.** Cada voto reenvía el snapshot completo a toda la sala, y el snapshot crece con cada carta cerrada. El tráfico de una sala crece con *jugadores² × cartas²*. Medido con el `RoomStore` real: una sala de 12 jugadores que vota los 107 juegos manda **~351 MB** sin comprimir. Con ese patrón, **14 salas así agotan el mes**. Un visitante que solo mira la landing pesa ~80 KB comprimido; 5 GB alcanzan para ~60.000 visitas así.
- **Steam no es el cuello de botella.** Gracias a la allowlist, la cache de 6 h y el dedupe, las llamadas a Steam crecen con el tamaño del catálogo (107 juegos) y no con la cantidad de usuarios. El riesgo real es el cold start: el disco de Render es efímero y la cache arranca vacía.
- **Problema de producto:** si el streamer muestra el QR en pantalla, los primeros 11 viewers ocupan la sala (máximo 12 jugadores) y sus amigos se quedan afuera. El host puede echar gente, pero no puede cerrar la inscripción.
- **CGNAT:** en Argentina, los celulares suelen compartir IP. Los límites por IP (5 salas por hora, 20 streams SSE, 20 códigos errados por minuto) se comparten entre desconocidos justo durante el pico.
- **SEO:** la base técnica está bien hecha (canonical, OG, JSON-LD, robots, sitemap, `noindex` en `/r/` y `/api/`). Lo que falta es **contenido indexable**: la landing tiene un `h1` y una línea, está marcada `hidden` hasta que corre el JS, y el sitemap tiene una sola URL. El activo SEO que ya existe son los **107 juegos curados con descripción propia en español** de `public/games.js`. Hay que convertirlos en páginas `/juegos/...` renderizadas por el server, sin build step.
- **Recomendación:** no empujar la app a streamers hasta tener **(1) eventos SSE incrementales** y **(2) el bandwidth medido en el dashboard de Render**. En paralelo y sin costo: landing visible del lado del server y páginas de juegos.

> "Indexado" en el sentido de base de datos no aplica: **no hay DB**. Las salas viven en un `Map` en memoria (`src/rooms.ts`) y cada lookup es O(1) por código. En este documento, "indexado" significa siempre **indexación en buscadores**.

---

## 1. El escenario

Supuestos (no medidos; ajustalos con los números reales del streamer):

| Parámetro | Valor supuesto |
|---|---|
| Viewers en vivo | 5.000–20.000 |
| Clic al link o escaneo del QR | 5–10 % en los primeros 10 min → **250–2.000 visitantes** |
| Visitantes que entran a la sala del streamer | todos lo intentan; entran 11 |
| Visitantes que crean su propia sala esa noche | 10–20 % → **25–400 salas nuevas** en 1–2 h |
| Requests por primera visita | ~37 (HTML + 35 módulos JS/CSS + `games.js` + `qrcode.js`) |

Con 2.000 visitantes en 5 minutos son ~74.000 requests, o sea **~250 req/s de pico** solo en estáticos.

## 2. Dónde se rompe hoy (en orden de aparición)

| # | Componente | Límite actual | Qué pasa con un streamer | Severidad |
|---|---|---|---|---|
| 1 | **Bandwidth Render free** | 5 GB/mes por workspace | Una sala de 12 jugadores × 107 cartas = ~351 MB de SSE. Un par de noches con streamer → servicio apagado hasta el 1° del mes siguiente | **Crítica** |
| 2 | **Sala del streamer** | `maxPlayers: 12` | Entran los primeros 11 viewers; el resto ve `room_full`. Trolls con nombres ofensivos (el filtro de nombres solo saca invisibles) | Alta (producto) |
| 3 | **Límites por IP con CGNAT** | 5 salas/IP/h · 600 req/min · 20 SSE/IP · 20 misses/min | Cientos de usuarios de una misma operadora móvil comparten una IPv4: el 6° que crea sala en esa hora recibe 429, y los códigos mal tipeados bloquean las búsquedas de todos durante 1 min | Alta |
| 4 | **CPU 0,1 vCPU** | Render free | ~250 req/s de pico en estáticos. Sin medir; estimo que 0,1 vCPU aguanta cientos de req/s simples, no miles → latencia alta y timeouts en el pico | Media-alta (sin medir) |
| 5 | **Cold start** | ~1 min tras 15 min sin tráfico | Si la app duerme cuando el streamer tira el link, el primer minuto todos ven la pantalla de carga de Render, y la cache de Steam arranca vacía | Media |
| 6 | **Capacidad global** | 500 salas · 2.000 SSE · 3.000 conexiones | Con 4 jugadores promedio, 500 salas = 2.000 streams: los dos topes llegan juntos. Antes revienta el bandwidth | Media |
| 7 | **Instancia única** | estado en memoria | Un OOM, un reinicio de Render o un deploy en medio del pico borran **todas** las salas | Media (ya asumido) |
| 8 | **Memoria 512 MB** | — | 500 salas × ~50 KB ≈ 25 MB. 2.000 sockets SSE con buffers de hasta 64 KB: el peor caso ronda los 130 MB. Hay margen | Baja |
| 9 | **Steam** | cola a 5 req/s, cache 6 h | Llamadas a Steam = O(catálogo) = ≤107 cada 6 h, sin importar cuántos usuarios haya. Solo duele si Steam devuelve 429 justo tras un cold start | Baja |

### 2.1 Bandwidth: el número que manda

**Lo verificado:**

- [Render, Outbound Bandwidth](https://render.com/docs/outbound-bandwidth): Hobby incluye **5 GB/mes**. Si se pasa sin medio de pago, Render apaga los servicios hasta el mes siguiente. El overage cuesta USD 0,15/GB, pero solo con tarjeta cargada.
- Producción (`curl` a `quejugamos.onrender.com`, 2026-10-17): Render pasa por Cloudflare y **comprime con brotli** (`Content-Encoding: br`). Las respuestas salen con `cf-cache-status: DYNAMIC`, o sea que **no hay cache de CDN**: cada request llega al proceso.

**Peso por tipo de tráfico** (brotli calculado localmente con `zlib`; `/api/steam` medido en producción):

| Tráfico | Bytes | Fuente |
|---|---|---|
| Primera visita a la landing (37 archivos) | 287 KB crudos → **~78 KB br** | `public/` |
| `hls.min.js` (solo con el primer trailer HLS) | 413 KB → ~103 KB br | lazy, `hls-loader.js` |
| `/api/steam/:id` por jugador y por carta | 4,4–7,3 KB → **1,2–2 KB br** | producción |
| Trailers, imágenes y capturas | **0**: los sirve el CDN de Steam directo al navegador | CSP `media-src` |
| **SSE por sala** | ver tabla siguiente | medido |

**SSE, medido con el `RoomStore` real** (votos al azar, snapshot completo por voto como hace `routes.ts`, **sin comprimir**):

| Jugadores × cartas votadas | Snapshot final | Bytes SSE de la sala | Salas así por mes (5 GB) |
|---|---|---|---|
| 4 × 20 | 6 KB | 1,3 MB | ~3.800 |
| 4 × 40 | 10 KB | 3,9 MB | ~1.300 |
| 8 × 40 | 14 KB | 20 MB | ~250 |
| 12 × 40 | 18 KB | 57 MB | ~90 |
| **12 × 107 (sala de streamer, catálogo completo)** | **43 KB** | **351 MB** | **~14** |

¿Por qué crece tan rápido? `vote` hace `hub.broadcast(snapshot)` a los N clientes en **cada** voto. El snapshot lleva `votes` (cada voto de cada jugador en cada carta cerrada), `results` y el `deck` entero. Bytes ≈ N votos por carta × N clientes × tamaño del snapshot, y el tamaño crece con las cartas cerradas.

**Lo que no verifiqué:** si Cloudflare comprime el stream `text/event-stream` evento por evento y si Render mide el bandwidth antes o después de comprimir. Un snapshot de 43 KB pesa 3,7 KB en gzip: si el stream sale comprimido, la sala de streamer baja de ~351 MB a **~30 MB**. Sigue siendo cuadrático y sigue siendo el consumo dominante. **Hay que medirlo** (paso Q1 del plan).

### 2.2 La sala del streamer

- El código y el QR que aparecen en pantalla son públicos. `join` no tiene otro control que `maxPlayers` y la unicidad del nombre.
- `kick` existe, pero el echado puede volver a entrar con otro nombre (el código no cambia).
- Lo que el streamer necesita es una de dos cosas: **cerrar la inscripción** (un toggle del host: "sala cerrada, no entra nadie más") o **aprobar a cada jugador**. El toggle es un cambio de contrato chico: API + frontend + mock + `docs/API.md`.
- Hasta que exista: la guía para streamers dice que compartan el link **por Discord o por el chat de suscriptores, no en pantalla**, y que usen 🔒 Cerrar sala y vuelvan a crearla si se les llena de desconocidos.

### 2.3 CGNAT y límites por IP

Los límites ya usan `rateLimitKey()`: IPv6 se agrupa por /64 (bien) e IPv4 queda como dirección única. Con CGNAT, una IPv4 de una operadora móvil agrupa a cientos de abonados desconocidos entre sí.

| Límite | Valor | Impacto bajo CGNAT | Propuesta (USD 0) |
|---|---|---|---|
| `roomsPerIpPerWindow` | 5/h | El 6° desconocido de la misma operadora no puede crear sala | Subir a **10–15/h**. Las salas basura de un atacante son lobbies con un solo host, y `evictIdleLobby` ya las desaloja al llegar a capacidad. Riesgo: un atacante que se une a sus propias salas evita el desalojo → mantener el tope global de 500 |
| `maxPerIp` SSE | 20 | El jugador N° 21 detrás de la misma IP no recibe actualizaciones | Subir a **40–60**. Abrir un stream exige un ticket atado a un jugador real, y crear jugadores ya está limitado por las salas por IP |
| `ROOM_MISS_MAX` | 20/min | Viewers que tipean mal el código del stream bloquean las búsquedas de todos los de su IP durante 1 min | Dejarlo: es la defensa contra adivinar códigos. El QR evita el tipeo |
| `API_RATE_MAX` | 600/min | ~3 req por jugador por carta. 600/min alcanza para ~200 votos por minuto por IP | Dejarlo y medir los 429 en los logs después del primer pico |

Todo cambio de límite va con su test de borde (Mistakes Log, 2026-10-09).

### 2.4 CPU, cold start y Steam

- **CPU:** `serveFile` hace un `fs.stat` por request (para revalidar la cache por mtime) y todos los estáticos salen con `no-cache`. Una visita repetida igual dispara ~37 revalidaciones (304). Sin build step no hay nombres con hash, así que no hay `immutable`. Subir `max-age` en módulos sueltos arriesga mezclar versiones tras un deploy, y no lo recomiendo.
  - **Medición USD 0:** `docker run --cpus=0.1 --memory=512m` replica la instancia free. Con `npx autocannon` desde afuera (sin agregarlo como dependencia) se obtiene el techo real de req/s. Hasta medirlo, los números de CPU de este documento son estimaciones.
- **Cold start:** el streamer abre el link 2 minutos antes de mostrarlo. Para streams agendados existe una opción USD 0: un cron de GitHub Actions que pegue a `/healthz` cada 10 min durante la ventana del stream. Ojo con dos cosas: 750 h/mes alcanzan para un solo servicio 24/7, y el cron de GitHub no es puntual.
- **Steam tras un cold start:** `.steam-cache.json` arranca en `{}` (lo crea el `Dockerfile`). `warmCache()` tarda ~25 s, y si Steam responde 429 en ese momento, todas las cartas quedan sin precio ni trailer durante 60 s o más.
  - **Mitigación USD 0:** commitear un **seed de la cache** (`data/steam-seed.json`, generado con un script) y copiarlo en la imagen. Arranca como dato viejo (stale), que `staleDetails`/`getCatalogPrices` ya saben usar, y se refresca solo.

## 3. Mitigaciones de escala, por impacto/costo

| Prioridad | Mitigación | Impacto | Esfuerzo | Costo |
|---|---|---|---|---|
| **P0** | **Medir**: bandwidth en Render (Dashboard → workspace → Usage) antes y después de una sala de prueba de 4 × 20; verificar si el SSE sale comprimido (`curl -N --compressed -v` contra `/events`) | Saber si el techo es 14 o ~170 salas de streamer por mes | 30 min | USD 0 |
| **P0** | **SSE incremental**: por voto, mandar un evento chico (`event: voters`, con `currentVoters` + `version`, ~100 B) y el snapshot completo solo al cerrar una carta, en `join`/`kick` y en los cambios de fase. Sacar `votes` de cartas cerradas del stream y servirlo bajo demanda en `finish`/export | 10–30× menos bytes SSE; deja de ser cuadrático en cartas | 1–2 días (cambio de contrato: backend + frontend + mock + `API.md` en un PR) | USD 0 |
| **P1** | Toggle "cerrar inscripción" para el host | Salas de streamer usables | ½–1 día (contrato) | USD 0 |
| **P1** | Guía para streamers (no mostrar el QR, pre-calentar la app, cerrar y recrear la sala) | Evita los dos fallos más visibles | 1 h (doc + copy) | USD 0 |
| **P1** | Subir `roomsPerIpPerWindow` y `maxPerIp` SSE (§2.3) con tests de borde | Menos 429 bajo CGNAT | 2 h | USD 0 |
| **P2** | Seed de la cache de Steam en la imagen | Cold start con datos | 2–3 h | USD 0 |
| **P2** | Load test con `docker --cpus=0.1` | Reemplaza las estimaciones de CPU por números | 2 h | USD 0 |
| **P2** | `qrcode.js` lazy (solo lo usa el lobby del host) | −12 KB br y un request menos por visita | 1 h | USD 0 |
| P3 | **Dominio propio + proxy de Cloudflare con cache de estáticos** | Estáticos casi fuera del cupo de 5 GB. Obliga a recalibrar `TRUSTED_PROXY_HOPS` (un hop más) | 1 día | **Cuesta plata** (dominio, ~USD 10/año; `.com.ar` en NIC es barato, pero no es USD 0) |
| P3 | Render Starter o pagar el overage de bandwidth | Sin spin-down, más CPU, sin corte por bandwidth | minutos | **Cuesta plata**: requiere tarjeta y **rompe la garantía de USD 0** (`docs/HOSTING-COSTS.md`) |
| P4 | Reescritura a Cloudflare Workers + Durable Objects | Sin instancia única ni cold start; estado por sala | semanas | USD 0 en el plan Free, pero con tope de requests diarios (100.000/día según recuerdo; **verificar**) que un pico grande puede agotar |

## 4. SEO: auditoría de lo que hay

| Qué | Estado | Dónde |
|---|---|---|
| `<html lang="es">`, `og:locale es_AR` | ✅ | `public/index.html` |
| Canonical absoluto desde `PUBLIC_ORIGIN` (nunca del `Host`) | ✅ bien pensado | `src/seo.ts`, `src/config.ts` |
| OG + Twitter card, imagen 1200×630 | ✅ | `index.html`, `og-image.jpg` |
| JSON-LD `WebApplication` (con `offers` en 0) | ✅ básico | `index.html` |
| `robots.txt` con `Allow: /` + sitemap | ✅. Bien que no bloquee `/r/`: así el crawler llega a ver el `noindex` | `src/seo.ts` |
| `X-Robots-Tag: noindex` en `/r/*` y `/api/*` | ✅ | `src/server.ts` (`NOINDEX_PATH`) |
| Verificación de Google y Bing por env | ✅ preparado; **falta usarlo** | `render.yaml` |
| Compresión brotli | ✅ la pone Render | producción |
| `<title>` | ⚠️ "¿Qué Jugamos?" solo, sin intención de búsqueda | `index.html` |
| Contenido de la landing | ❌ `h1` + una línea, dentro de `<main hidden>`. Crawlers sin JS (Bing a veces, previews sociales, crawlers de IA) ven una página vacía, y el LCP espera a que cargue todo el grafo de módulos | `index.html`, `views/landing.js` |
| Sitemap | ❌ una sola URL | `src/seo.ts` |
| Enlaces internos | ❌ ninguno: no hay nada más para enlazar | — |
| Fuentes | ⚠️ CSS de Google Fonts que bloquea el render, más dos orígenes externos en el CSP | `index.html`, `server.ts` |
| Canonical en `/r/:code` | ⚠️ apunta a `/` y además hay `noindex`: señales mezcladas, impacto bajo | `index.html` sirve las dos rutas |
| Dominio `*.onrender.com` | ⚠️ "¿qué jugamos?" es una frase común: posicionar la marca en un subdominio compartido es difícil | `render.yaml` |
| Tests | ✅ config, render, robots, sitemap y headers | `test/seo.test.ts` |

## 5. SEO: propuestas

### 5.1 Decisión previa: el dominio

Todo link que consiga el streamer suma autoridad **al dominio en el que esté la app**. Si se va a comprar dominio (**cuesta plata**), conviene hacerlo **antes** de la campaña. La migración igual está resuelta: `PUBLIC_ORIGIN` cambia el canonical en un solo lugar, y `*.onrender.com` puede seguir vivo redirigiendo con 301. Sin dominio, todo lo de abajo funciona igual en `quejugamos.onrender.com`.

### 5.2 Páginas indexables desde `public/games.js` (sin build step, sin dependencias)

El server ya importa `GAMES` y `PLATFORMS`. Un `src/pages.ts` con funciones puras `(games, origin) → html` renderiza todo **una vez al arrancar** en un `Map<path, {html, etag}>`. Las sirve el mismo `sendCacheable` con ETag. Son **cero JS** (Core Web Vitals perfectos), usan `styles.css` + un `pages.css` chico y no tienen estilos inline (CSP intacta).

| Ruta | Cantidad | Intención de búsqueda (es-AR/LatAm, sin volúmenes medidos) |
|---|---|---|
| `/juegos/` | 1 | "juegos cooperativos para jugar con amigos" |
| `/juegos/plataforma/{pc,playstation,xbox,switch,mobile}` | 5 | "juegos co-op para PC", "juegos para jugar con amigos en Switch" |
| `/juegos/para-2-jugadores`, `para-4-jugadores`, `para-6-o-mas` | 3 | "juegos para 2 jugadores online", "juegos para 4 amigos" |
| `/juegos/genero/{terror,party,supervivencia,...}` | solo tags con ≥ 5 juegos | "juegos de terror cooperativos" |
| `/juegos/{id}` | 107 | "Lethal Company cuántos jugadores", "R.E.P.O. crossplay" |
| `/streamers` | 1 | "juego para elegir con el chat", landing de campaña |

Reglas para que no lo traten como contenido programático de baja calidad:

- **Texto propio:** el `pitch` en español de `games.js` es único. Nada de copiar `short_description` de Steam (contenido duplicado y ajeno).
- **Sin datos en vivo de Steam en estas páginas:** ni precio ni trailer. Un crawler nunca dispara llamadas a Steam (protege el upstream y el bandwidth), y no se publica un precio que puede quedar viejo. Imágenes: el `header` de Steam vía `img-src` ya permitido, con `width`/`height` fijos.
- Cada página de juego muestra jugadores, plataformas, crossplay (con "sin verificar" honesto cuando corresponda), tags, **juegos relacionados** (mismo tag o rango de jugadores = enlaces internos) y un CTA: "Votalo con tu grupo →" a `/`.
- Arrancar con los hubs (plataforma, jugadores, género), que concentran la intención de búsqueda. Si Search Console marca muchas fichas como "Rastreada: actualmente sin indexar", enriquecerlas antes de sumar más páginas.

### 5.3 Datos estructurados

- Landing: sumar `WebSite` con `name: "¿Qué Jugamos?"` y `alternateName: "Que Jugamos"` (Google lo usa para el nombre del sitio en el SERP), y completar `WebApplication` con `description`, `image` y `browserRequirements`.
- `/juegos/{id}`: `VideoGame` con `name`, `url`, `gamePlatform`, `genre`, `playMode` (`CoOp`/`MultiPlayer`), `numberOfPlayers` (`QuantitativeValue` min/max) y `sameAs` a la página de Steam. **Sin `offers`/precio** (ver arriba).
- Hubs: `ItemList` + `BreadcrumbList`.
- FAQ visible en la landing ("¿Es gratis?", "¿Hay que descargar algo?", "¿Cuántos pueden votar?"). Google solo muestra rich results de FAQ para sitios de gobierno y salud, así que el valor está en el texto, no en el schema.
- El JSON-LD va en `<script type="application/ld+json">`: es un bloque de datos que no se ejecuta, así que la CSP `script-src 'self'` no lo bloquea (ya funciona así hoy).

### 5.4 Landing y Core Web Vitals

1. **Server-render de la landing visible en `/`.** `serveIndex` sabe si la ruta es `/` o `/r/:code`: con un placeholder, `hidden` queda solo en las rutas de sala. Así el `h1` es el LCP sin esperar el JS, y los crawlers sin JS ven contenido.
2. Sumar a la landing una sección "Cómo funciona" (3 pasos), el FAQ y **enlaces a `/juegos/...`** (hoy la landing no enlaza a nada).
3. `<title>` con intención: "¿Qué Jugamos? · Elegí a qué jugar con tus amigos desde el celu" (~60 caracteres). Mantener la description.
4. **Fuente propia:** Space Grotesk es OFL. Subset woff2 en `public/fonts/` con su licencia al lado, `font-display: swap`. Se sacan `fonts.googleapis.com` y `fonts.gstatic.com` del CSP (CSP más estricta, sin terceros, mejor privacidad).
5. `<link rel="modulepreload">` para los módulos del primer render, para aplanar la cascada de imports. Cargar `qrcode.js` solo en el lobby del host.

### 5.5 Rutas de sala, canonical y hreflang

- `/r/:code`: mantener el `X-Robots-Tag: noindex` y **sacar el canonical** a `/` en esas respuestas (ya se renderizan aparte en el punto 5.4). OG propio para las previews en WhatsApp y Discord: "Te invitaron a votar a qué jugar". **Nunca** con datos de la sala (nombres = datos personales).
- Canonical absoluto en cada página nueva, siempre desde `PUBLIC_ORIGIN`. Los query params (`?ref=`) no cambian el canonical.
- hreflang: con un solo idioma aporta poco. Agregar `hreflang="es"` + `x-default` autorreferentes es gratis y deja preparado un futuro `pt-BR`. El copy usa voseo, así que `og:locale es_AR` está bien.

### 5.6 Links compartibles para streamers

- **Ya existe:** `?ref=twitch` (vocabulario cerrado en `src/acquisition.ts`). `captureRef` lo saca de la URL y el canonical no lo ve. Usarlo ya en los paneles de Twitch y las descripciones de YouTube.
- **Por streamer:** una allowlist por env (`STREAMER_REFS=s-fulano,s-mengana`) que extienda `REF_SOURCES`. Nunca texto libre del cliente en logs; un ref desconocido sigue mapeando a `other`.
- `/streamers`: página indexable con la guía (cómo usarlo en vivo sin trolls, abrir el link antes del stream, los límites honestos: 12 jugadores por sala). Es el link que se pasa a streamers.
- Los links de Twitch y YouTube suelen ser `nofollow`, así que suman tráfico y búsquedas de marca más que autoridad. Las búsquedas de marca importan igual, y con un dominio propio se capitalizan.

### 5.7 Operación (USD 0)

- Dar de alta Search Console y Bing Webmaster (las env vars ya existen), enviar el sitemap y mirar "Páginas" y "Rendimiento" cada semana.
- Sitemap generado desde la misma lista de rutas que `pages.ts`, con `lastmod` = mtime de `games.js`. Opcional: IndexNow para Bing.

### 5.8 Tests que necesita la parte de SEO

- Cada juego de `GAMES` tiene su página (200); un id desconocido da 404; un path malformado da 4xx y el proceso sigue vivo.
- El sitemap lista exactamente las rutas renderizadas.
- Todo JSON-LD parsea con `JSON.parse`; cada página tiene canonical absoluto y `<title>` único.
- Ningún HTML contiene "Tinder"; ningún HTML tiene `style=`, `<style>` ni `<script>` ejecutable inline.
- Las rutas de sala mantienen el `noindex` y no llevan canonical.

## 6. Plan priorizado

### Quick wins (USD 0, implementables ya)

| # | Qué | Quién | Esfuerzo |
|---|---|---|---|
| Q1 | Medir el bandwidth real y la compresión del SSE en Render (§3, P0) | Agus (dashboard) + Claude (curl) | 30 min |
| Q2 | Search Console + Bing + envío del sitemap | Agus | 30 min |
| Q3 | Guía para streamers + usar `?ref=twitch` | Claude (copy) | 1 h |
| Q4 | `<title>`, `WebSite` JSON-LD, sacar el canonical de `/r/` | Claude | 1–2 h + tests |
| Q5 | Landing visible desde el server + "Cómo funciona" + FAQ | Claude | ½ día + check en browser |
| Q6 | Fuente propia + `modulepreload` + `qrcode.js` lazy | Claude | ½ día |
| Q7 | Ajuste de límites para CGNAT con tests de borde | Claude | 2 h |
| Q8 | Seed de la cache de Steam en la imagen | Claude | 2–3 h + docker smoke |

### Trabajo grande

| # | Qué | Por qué | Costo |
|---|---|---|---|
| G1 | **SSE incremental** (cambio de contrato) | Bloquea cualquier campaña con streamers: sin esto, el cupo mensual se va en pocas noches | USD 0 |
| G2 | Páginas `/juegos/...` + sitemap + JSON-LD | El grueso del SEO | USD 0 |
| G3 | "Cerrar inscripción" para el host | Salas de streamer usables | USD 0 |
| G4 | Load test con 0,1 vCPU | Reemplazar estimaciones por números | USD 0 |
| G5 | Dominio + Cloudflare con cache | Autoridad propia + estáticos fuera del cupo | **Cuesta plata** |
| G6 | Workers + Durable Objects | Saca el techo de instancia única | USD 0 con topes; semanas de trabajo |

**Orden recomendado:** Q1 → G1 → Q3/Q7 → Q4/Q5 → G2 → G3. El resto según los números de Q1 y G4.

## 7. Lo que no verifiqué

- Si el SSE sale comprimido por Cloudflare y si Render mide el bandwidth antes o después de comprimir. Esto cambia el techo ~12×, pero no el orden de prioridades.
- El techo de req/s con 0,1 vCPU (no hice load test).
- El tope diario de requests de Workers Free y la disponibilidad de Durable Objects en el plan gratis.
- Si `onrender.com` está en la Public Suffix List. Afecta cómo Google trata al subdominio como sitio independiente.
- Volúmenes de búsqueda de las keywords de §5.2 (validar con Search Console y Google Trends una vez indexado).

## 8. Propuesta para `CLAUDE.md` (Riesgos abiertos)

> - **Bandwidth de Render free: 5 GB/mes.** Si se pasa sin tarjeta, el servicio queda apagado hasta el mes siguiente. El SSE manda el snapshot completo por voto: una sala de 12 × 107 ≈ 351 MB sin comprimir (`docs/STREAMER-SCALE-SEO.md`). No empujar campañas grandes sin eventos incrementales.

## Fuentes

- [Render: Outbound Bandwidth](https://render.com/docs/outbound-bandwidth) — 5 GB en Hobby; spin-down sin medio de pago.
- [Render: Compute Plans](https://render.com/docs/compute-plans) — free = 0,1 CPU / 512 MB.
- [Render: Free instances](https://render.com/docs/free) — spin-down a los 15 min, 750 h/mes, reinicios.
- [Render community: brotli](https://community.render.com/t/disable-brotli-compression/535) — compresión automática en el balanceador; confirmado con `curl` en producción.
- Mediciones propias: script sobre `RoomStore` (snapshot por voto), tamaños brotli de `public/` con `node:zlib`, `curl` a `/api/steam/:id` en producción (2026-10-17).
