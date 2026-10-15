# Grabación de clips + plan para el día que lo use un streamer

**Fecha:** 2026-10-14 · **Autor:** Claude (growth) · **Audiencia:** Agus · **Versión:** 1.0 · Complementa `estrategia-organica.md` (§3.1, §7) y `tiktok-kit.md` (§6)

## TL;DR
- **Segunda sesión grabada: con 4 o más personas y con fecha fija.** No esperes a que esté todo perfecto.
- **Lo que define si se pueden hacer clips es grabar en local con pistas de audio separadas.** Sin eso, no podés sacar la música del juego sin perder las voces.
- **Si mañana lo usa un streamer, lo primero que rompe no es el tope de 500 salas.** Rompe el rate limit de 5 salas por IP por hora (le da error en vivo) y, ante un pico, el ancho de banda del plan free. Los dos están pedidos al equipo de producto (R1, R2).
- **Twitter: una sola cuenta `@quejugamos`** para novedades y avisos, linkeada desde las pantallas de error de la app (R3). No abras una cuenta de estado aparte.

## 1. Antes de grabar (una vez, ~45 min)

| # | Qué | Cómo | Por qué |
|---|---|---|---|
| 1 | **Pistas de audio separadas** | OBS → Ajustes → Salida → modo **Avanzado** → Grabación → activar pistas 1–4. Asignar en cada fuente con "Propiedades avanzadas de audio": **1** mezcla · **2** tu mic · **3** Discord (voces de tus amigos) · **4** juego + browser | Permite silenciar la música del juego o un trailer en edición sin perder las voces. Es el punto más importante de la lista |
| 2 | **Separar Discord y el browser del audio del escritorio** | Fuente "Captura de audio de aplicación" en Windows, una por app. Si no aparece en tu versión de OBS, salida de Discord a otro dispositivo de audio | Si todo entra por "Audio del escritorio", vuelve a quedar mezclado en una sola pista |
| 3 | **Grabación local, aparte del stream** | Formato **MKV**, 1080p, 30 o 60 fps. Al terminar: Archivo → Remuxear a MP4 | MKV no se corrompe si OBS se cuelga. El VOD de Twitch viene comprimido y con la música silenciada |
| 4 | **Layout pensado para 9:16** | La cámara y la zona de la carta o el overlay de MATCH tienen que entrar en una franja vertical del centro (~1/3 del ancho). Plugin opcional: Aitum Vertical (**no lo probé**) | Si no entran, cada clip necesita reencuadres a mano |
| 5 | **Replay Buffer + hotkeys** | Ajustes → Salida → Replay Buffer de 60 s, con hotkey para guardar. Otro hotkey para "marcador" si tu OBS lo tiene; si no, anotá la hora en un papel | Buscar los 20 s buenos en 2 h de grabación es lo que más tiempo lleva |
| 6 | **Mic** | Filtros en OBS: supresión de ruido + compresor + limitador a −1 dB | Que gritar en el match no sature el audio |
| 7 | **Cámara y luz** | Luz de frente (lámpara detrás de la cámara), ningún fondo con ventana a contraluz | Una cara oscura no retiene en los primeros 3 s |
| 8 | **App** | Trailers en mute en la app, o el browser solo en la pista 4. Abrir la app 2 min antes (cold start). Entrar desde `?ref=yo` | Audio de terceros fuera de los clips y métricas limpias |
| 9 | **Celulares** | 1–2 amigos graban la pantalla mientras votan | Para intercalar el swipe en primer plano |
| 10 | **Consentimiento** | Avisar que el material va a clips públicos. Tapar nombres de Discord en las capturas | Privacidad |

### Prueba de 2 minutos (el mismo día, siempre)
1. Grabá 2 min hablando vos, hablando un amigo por Discord y con un trailer sonando.
2. Abrí el MKV en un editor (CapCut o DaVinci, los dos gratis) y fijate que haya **4 pistas** y que cada una tenga solo lo suyo.
3. Las voces de Discord tienen que estar a un nivel parecido al de tu mic. Si no se escuchan, subí Discord en el mezclador.

## 2. Durante la sesión grabada

| Para que haya buenos clips | Cómo |
|---|---|
| Ser **4 o más** | El momento "falta que vote uno" necesita grupo |
| Mazo corto, juegos que todos conocen | Filtrar por cantidad de jugadores y precio bajo: llegan antes al match |
| No cortar en el match | Dejar correr 5 s después del overlay: la reacción buena es la tardía |
| Marcar momentos | Hotkey de Replay Buffer o anotar la hora cada vez que pasa algo |
| Repetir 2–3 rondas | Elegís la reacción más genuina; actuadas no sirven |

## 3. Edición: de 2 h a 3–5 clips

| Paso | Detalle |
|---|---|
| 1. Elegir | Solo momentos con **tensión → resolución**: duda del último voto → match, desacuerdo → match inesperado, o un "ya lo jugué" gracioso |
| 2. Cortar | 15–30 s. Arrancar en la acción, sin presentarte (hooks en `tiktok-kit.md` §2) |
| 3. Audio | Pista 4 (juego/trailers) en mute o muy baja. Música, solo de la **Commercial Music Library** en TikTok y re-elegida dentro de IG (`tiktok-kit.md` §6) |
| 4. Texto | Subtítulos siempre + 1 frase de contexto arriba ("mi grupo eligiendo a qué jugar") |
| 5. Cierre | Pantalla final: "¿Qué Jugamos? · gratis · sin descargar" + link en bio con `?ref=tt` / `ig` / `yt` |
| 6. Exportar | Master **sin marca de agua**, subido nativo a cada plataforma |

## 4. El día que lo usa un streamer

### 4.1 Qué se rompe primero (ordenado por probabilidad)

| # | Qué falla | Cuándo | Estado |
|---|---|---|---|
| 1 | **Rate limit: 5 salas por IP por hora** (`src/rooms.ts`). Con rondas de 11 viewers el streamer crea más de 5 salas en la primera hora → error `rate_limited` en vivo | En la primera hora de su stream | **Pedido R1**: nueva ronda dentro de la misma sala |
| 2 | **Cold start de ~1 min** si nadie usó la app en 15 min ([Render](https://render.com/docs/free)) | Al arrancar | Mitigación manual: abrir la app 2 min antes |
| 3 | **Deploy durante su stream**: un merge verde a `main` deploya y borra todas las salas | Si se mergea algo en ese horario | Mitigación manual: freeze de merges coordinado con la sesión de código |
| 4 | **Ancho de banda: 5 GB de salida por mes por workspace en el plan free** desde el 1/8/2026 (fuentes de terceros: [Render docs](https://render.com/docs/outbound-bandwidth), [jwatte.com](https://jwatte.com/blog/render-com-platform-review/); **no verifiqué la página oficial**). Qué pasa al excederlo sin tarjeta: **no verificado**, lo más probable es la suspensión | En los días siguientes, cuando sus viewers crean salas propias | **Pedido R2** |
| 5 | **500 salas en simultáneo** | Solo con un pico muy grande | Poco probable con 1 streamer chico |
| 6 | **750 h por mes por workspace** | Si hay otro servicio free en el workspace | Revisar el dashboard (`estrategia-organica.md` §7) |

**Ancho de banda: medición en producción (2026-10-14, curl con brotli).** Cloudflare ya comprime, pero hoy los estáticos salen sin `Cache-Control` (`cf-cache-status: DYNAMIC`) y se re-descargan en cada visita. **Con el PR #5** (`src/static-cache.ts`) JS, CSS y HTML pasan a `no-cache` + ETag: las visitas que vuelven reciben 304 sin body. Las imágenes llevan `max-age` largo. La estimación de abajo vale para **primeras visitas**.

| Recurso | Peso transferido |
|---|---|
| `hls.min.js` | 129 KB (cargado para todos, aunque no vean trailers) |
| `og-image.png` | 311 KB (la piden los bots de Discord, WhatsApp, etc. en cada preview nuevo) |
| HTML + CSS + JS propio + `games.js` | ~40–70 KB |
| **Primera visita estimada** | **~200 KB → ~25.000 visitas/mes con 5 GB** (sin contar el proxy de Steam ni SSE) |

Los trailers no cuentan: se sirven desde el CDN de Steam, no desde nuestro server.

### 4.2 Checklist del día

| Cuándo | Qué | Quién |
|---|---|---|
| Al acordar con el streamer | Horario exacto + canal directo (Discord o WhatsApp) para avisarse si algo falla | Agus |
| Al acordar | Pedir **freeze de merges** a `main` en ese horario | Agus → sesión de código |
| Al acordar | Confirmar que R1 está en prod. Si no, que **no rote salas**: una sala por ronda larga, o vos creás las salas | Agus |
| T−5 min | Abrir la app (cold start). Crear una sala de prueba con `?ref=yo` | Agus |
| T−5 min | Dashboard de Render abierto: métricas y logs | Agus |
| Durante | Mirar los logs por `capacity` / `rate_limited` / 5xx | Agus |
| Si se cae | 1) Mensaje directo al streamer. 2) Post en `@quejugamos`. 3) Revisar el dashboard de Render (¿suspendido? ¿reinicio?) | Agus |
| T+1 día | Exportar logs + correr `scripts/metrics-from-logs.mjs`. Mirar el ancho de banda consumido en el dashboard | Agus |

### 4.3 Mensajes listos para `@quejugamos`

| Situación | Texto |
|---|---|
| Lenta al abrir | "Si ¿Qué Jugamos? tarda en abrir, esperá un minuto: se está despertando 😴 Después anda rápido." |
| Caída | "¿Qué Jugamos? está caído. Lo estamos mirando; las salas abiertas se perdieron, perdón 🙏 Aviso acá cuando vuelva." |
| Volvió | "Volvimos ✅ Creá una sala nueva y a votar." |
| Llena | "Hoy se llenó todo 😅 Si te da error, probá en un rato. Gracias por jugar." |

## 5. ¿Cuenta de Twitter? Sí, con estas condiciones

| Decisión | Por qué |
|---|---|
| **Una sola cuenta `@quejugamos`** (novedades + avisos) | Una cuenta solo para estado no la sigue nadie antes del primer incidente |
| **Linkeada desde las pantallas de error de la app** (R3) | Durante una caída la gente está mirando la app, no buscando en Twitter |
| **El aviso principal a un streamer es directo**, Twitter va de respaldo | El streamer avisa en su propio stream; eso llega más que cualquier tweet |
| Reservar el handle ya | Es requisito de R3. Está en S0 del plan |
| Monitor externo gratis con página de estado (p. ej. UptimeRobot) | **Opcional, no verificado.** Ojo: un ping cada 5 min mantiene despierto el servicio 24/7 y consume las ~744 h del mes. Solo va si es el único servicio free del workspace |

## 6. Pedidos al equipo de producto (enviados 2026-10-14 a "Orchestrate next ¿Qué Jugamos? release"; respuesta el mismo día)

| # | Pedido | Por qué | Prioridad | Estado |
|---|---|---|---|---|
| **R1** | Nueva ronda dentro de la misma sala (mismo código y QR), en vez de crear salas nuevas. **No** subir el límite global | El streamer no choca con 5 salas por IP por hora | **Bloquea a streamers** | **Espera decisión de Agus.** Cambia el contrato (endpoint + estado + SSE) y compite con SuperLike y la popularidad global. La pausa del PR #4 no lo cubre |
| **R2** | `Cache-Control` en los estáticos · `hls.min.js` lazy, solo al reproducir un trailer · `og-image` a JPG/WebP de ~60 KB · (opcional) estimar bytes servidos por día | Estirar los 5 GB del plan free | Alta, antes de buscar streamers | Cache: **hecho** (PR #5). hls lazy + og-image: **tomados** para la release siguiente. Bytes por día: backlog |
| **R3** | Línea "¿Algo no anda? Avisos en @quejugamos" en las pantallas de error. Solo link, sin embeds de X | Canal de estado visible | Media, después de reservar el handle | **Tomado**: se hace apenas Agus confirme el handle |

La prioridad frente a las mejoras del primer stream la decide Agus.

## 7. Próximos pasos

| Acción | Quién | Cuándo |
|---|---|---|
| Pasar la lista de mejoras del primer stream para separar "bloquea grabación" de "después" | Agus → Claude | Ya |
| Reservar `@quejugamos` en X (y en TikTok, IG y YT si falta) | Agus | Esta semana |
| Configurar OBS (§1) + prueba de 2 min | Agus | Antes de la sesión grabada |
| Fecha de la sesión grabada con 4 o más personas | Agus | Fijarla esta semana |
| Verificar en el dashboard de Render: ancho de banda incluido y consumido en el mes | Agus | Esta semana |
| Decidir prioridad de R1 frente a SuperLike y popularidad global | Agus | Cuando lo plantee el orquestador |
| Avisar al orquestador cuando `@quejugamos` esté reservado (desbloquea R3) | Agus | Al reservarlo |
| Contactar streamers recién con R1 y R2 en prod | Agus | Después del deploy |
