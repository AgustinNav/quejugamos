# Estrategia orgánica — primeros 30 días

**Fecha:** 2026-10-12 · **Autor:** Claude (growth) · **Audiencia:** Agus (decide y publica) · **Versión:** 1.0 · **Presupuesto:** USD 0

## TL;DR
- **Meta:** 5 salas por semana **creadas por gente que no sos vos** en la semana 4. Con tus amigos llegás a 5 sin hacer marketing, así que tus salas de prueba no cuentan (`?ref=yo`).
- **Motor:** tus streams. Una sesión de 2 h de stream usando la app rinde para el canal (el chat vota en vivo) y además deja de 3 a 5 clips para TikTok, Reels y Shorts. No hace falta grabar contenido aparte.
- **Canales en orden de prioridad:** 1) Discord donde ya participás, 2) tu stream y sus clips, 3) streamers chicos de AR que usen la app en vivo, 4) Reddit, solo en subs que lo permitan, 5) X. El SEO no va a traer salas en 30 días, pero la base técnica se hace igual porque es barata.
- **Bloqueante:** sin `?ref=` y los logs de métricas (P1) no se puede saber qué funcionó. No publiques fuera de tu círculo hasta que P1 esté en producción. La sesión de código lo está haciendo en `feat/growth-metrics-seo` y no deploya sin tu OK.
- **Riesgo más probable:** un clip que pega fuerte. Hay tope de 500 salas, 12 jugadores por sala, cold start de ~1 min y una sola instancia. Abajo está el plan para ese caso.

## 1. Posicionamiento

> **Para el grupo de Discord que tarda más en elegir el juego que en jugarlo: cada uno vota desde el celu y en 2 minutos hay match.**

| Somos | No somos |
|---|---|
| Un decisor grupal: resuelve "¿a qué jugamos?" esta noche | Un catálogo ni un recomendador con IA |
| Algo sin fricción: link → QR → votar, sin cuenta y sin descargar nada | Una app de stores ni una red social de gamers |
| Juegos co-op curados (107), con precio de Steam AR en USD | "Todos los juegos" ni precios de consola o en pesos |

Usamos la mecánica de swipe ("deslizá", "match") sin nombrar la marca de citas.

## 2. Loop de crecimiento de producto

Cada sala expone la app a entre 2 y 12 personas que **la usan**: no ven un anuncio, la prueban. El crecimiento depende de cuántos de esos invitados después crean su propia sala con otro grupo.

```
Host crea sala → comparte link/QR en Discord (preview OG = anuncio gratis)
      → 2–11 invitados votan → MATCH
      → algún invitado juega con OTRO grupo → crea su sala → ...
```

**Cuenta honesta:** k = invitados por sala × % de invitados que después crean una sala. Con 4 invitados y un 5 % de conversión, k = 0,2. Con k < 1 el loop no se sostiene solo: **amplifica** lo que entra por los canales, pero no reemplaza esa entrada. Por eso los canales importan, y por eso hay que medir `viaGuest` (P1) desde el día 1.

| Momento del invitado | Qué ve hoy | Qué debería ver (pedido) |
|---|---|---|
| Recibe el link en Discord | Preview genérico, con imagen que puede no cargar (og:image relativa, se arregla en P2) | Preview "Te invitaron a votar a qué jugar" (P5) |
| Hay match | Overlay IT'S A MATCH 💘 | Un CTA "¿Jugás con otro grupo? Creá tu sala" y una tarjeta para compartir "Esta noche jugamos X" (P3, P4) |
| Entra a una sala que ya se cerró | "La sala se cerró" | El mismo mensaje con un botón para crear una sala propia (P3) |

## 3. Canales, ordenados por salas esperadas por hora de esfuerzo

Las estimaciones son **mi juicio sin datos**: la medición de la §5 existe para reemplazarlas en la semana 2.

| # | Canal | Por qué para este público | Esfuerzo | Salas/hora esperadas | Techo | Reglas / cuidado |
|---|---|---|---|---|---|---|
| 1 | **Discord** (servers donde ya estás, grupos de amigos de amigos, comunidades AR de juegos co-op) | El mensaje cae justo donde se discute "¿a qué jugamos?" | Bajo: 1 mensaje (`copy.md`) | **Alta** | Bajo, porque no escala más allá de tus servers | Solo donde participás o con OK de un mod, en el canal correcto, una vez. Nada de DMs masivos |
| 2 | **Tu stream** usando la app con el chat | Ya streameás: el costo marginal es casi cero y el chat ve el producto andando | Bajo: el stream lo hacés igual | **Media-alta** | 12 por sala, así que hay que rotar salas (§3.1) | Silenciá trailers y música del juego en los clips (§7) |
| 3 | **Clips → TikTok / Reels / Shorts** | Es el único canal con chance de alcance grande. El público 16–30 está ahí | Medio: 30–45 min por clip, y el mismo master sirve para las 3 plataformas | **Muy variable** (0 o 100) | Alto | Audio de la Commercial Music Library en TikTok y re-elegir el audio en IG (`tiktok-kit.md`). Subí el master sin marca de agua |
| 4 | **Streamers chicos de AR** (50–500 viewers, juegan co-op con amigos) | Un streamer que lo usa en vivo lo muestra a su chat **y** a su grupo | Medio: DM personalizado + seguimiento | **Media** (muy apalancado si uno lo adopta) | Medio | Pedido honesto: "si te sirve, usalo; si no, decime qué falta". Nada de pagos ni canjes. Nunca sugerir que es oficial |
| 5 | **Reddit** | Hay poco público hispano. Sirve más para feedback y para que te mencionen en búsquedas e IA que para conseguir salas | Medio: hay que participar antes de postear | **Baja** | Medio | Ver §3.2 |
| 6 | **X / Twitter gaming AR** | Público disperso; sirve para responder threads de "¿qué juego co-op recomiendan?" | Bajo | **Baja** | Bajo | Responder con valor y el link solo si encaja |
| 7 | **SEO + buscadores con IA** | La gente busca "juegos co-op para 4" y no "app para votar juegos" | Medio, y lo hace la sesión de código | **≈0 en 30 días**: es la base para el mes 3 o más | Alto a largo plazo | Ver §6 |

### 3.1 Stream con el chat: cómo encajar el tope de 12

| Problema | Solución sin código | Solución con código (pedido) |
|---|---|---|
| En una sala entran 12 personas y el chat puede ser más grande | Ronda por sala: entran los primeros 11, hay match, se crea una sala nueva y entran otros. Cada ronda es contenido nuevo | — |
| El viewer ve el stream en el mismo celu que usaría para escanear el QR | Comando `!sala` en el bot del chat (Nightbot o StreamElements, que tienen plan gratis) con el link `/r/CODE`. Lo actualizás en cada ronda | Código grande y legible en pantalla (P6) |
| Trolls con nombres ofensivos en pantalla | Moderar el chat. Si aparece un nombre así, se cierra esa sala y se abre otra | Que el host pueda echar a un jugador y ocultar nombres en "modo stream" (P6) |
| Cold start de ~1 min | Abrir la app 2 min antes de arrancar el stream | — |
| Rate limit de 5 salas por IP por hora: si rotás muchas rondas te puede frenar | Rondas más largas (mazo filtrado) o probarlo en S0 | Evaluar con producto si hace falta |
| Tus salas inflan la métrica | Abrir la app desde `?ref=yo` | — |

### 3.2 Reddit: candidatos (todo **no verificado**: leé el sidebar o la wiki de cada sub antes)
| Sub | Uso | Cuidado |
|---|---|---|
| r/CoopGaming, r/gamingsuggestions | Responder "¿qué jugamos con 4?" con recomendaciones reales y mencionar la app solo si viene al caso | No encontré las reglas de autopromoción de estos subs |
| r/devsarg, r/SideProject | Post "hice esto" con el repo público: sirve para feedback técnico y menciones | r/devsarg es público de devs, no el público objetivo |
| r/argentina | Solo si las reglas lo permiten | No verificado |

Regla sitewide: "es válido ser un redditor con un sitio web, pero no un sitio web con una cuenta de Reddit" (reddiquette, citado en [redship.io](https://redship.io/blog/reddit-self-promotion-rules-2026)). El famoso 10 % de autopromoción es una regla comunitaria: no la pude verificar en el texto oficial. Hay subs gaming grandes que la aplican y sacan los posts propios si superan ~10 % de tu actividad ([r/Games FAQ](https://axebps-redlib.hf.space/r/Games/wiki/faq), [r/pcgaming wiki](https://redlib.belloworld.it/r/pcgaming/wiki/selfpromotion)), y otros prohíben la autopromoción del todo ([r/rpg_gamers](https://lr.sudovanilla.org/r/rpg_gamers/comments/q3gtoj/updates_to_the_rules)). Las reglas de cada sub siempre son más estrictas que las de Reddit, nunca más laxas.

## 4. Calendario de 4 semanas

Supuesto: **2 sesiones de 2 h por semana**, unas 4 h en total. Si una semana hay una sola sesión, se hace la fila marcada ⭐ y se saltea el resto.

| Semana | Sesión A (2 h) | Sesión B (2 h) | Salida | Gate para avanzar |
|---|---|---|---|---|
| **S0 — prep** (antes de publicar) | Reservar handles `@quejugamos` (TikTok, IG, YouTube). Bio y comentario fijado de `copy.md`. Comando `!sala`. Pegar el link en un Discord de prueba y mirar el preview | (sesión de código) deploy de P1 + P2 con tu OK. Probar crear 6 salas en 1 h desde tu IP | Medición andando | **P1 en prod**. Sin esto no se pasa a S1 |
| **S1** | ⭐ Stream con 3–5 amigos usando la app. Marcá los momentos con timestamps (el match, la duda del último voto) | Editar 2 clips (el guion B "match" sale solo de ahí). Publicar en TT, Reels y Shorts. Mensaje en 2–3 Discord con `?ref=dc` | 2 clips, 3 posts Discord | Pasa a S2 aunque no haya resultados |
| **S2** | ⭐ Stream con el chat votando (§3.1), rondas de 11 | 2 clips más, uno con el chat. DM a 5 streamers chicos con link `?ref=twitch` | 2 clips, 5 DMs | Exportar logs y correr el script (§5) |
| **S3** | ⭐ Revisar métricas (20 min). Duplicar en el canal con más salas por hora. Grabar el hook que más retuvo en otra variante | Reddit: 1 post en un sub que lo permita. Seguimiento a los streamers | 1–2 clips, 1 post Reddit | Decisión de la §5 |
| **S4** | ⭐ Stream + clips del formato ganador | Retro: ¿se llegó a 5 salas por semana de terceros? Decidir el mes 2 (seguir, cambiar de canal o pedir P3/P4 si `viaGuest` está bajo) | Doc corto de retro | — |

**Un clip ≠ un video nuevo.** Un stream de 2 h deja de 3 a 5 clips de 15–30 s. Exportá el master limpio (sin marca de agua) y subilo nativo a las 3 plataformas. Las reglas de IG sobre reposts con marca de agua están en `tiktok-kit.md` §5.

## 5. Medición: qué medimos y qué decisión dispara cada número

**Cómo funciona (acordado con la sesión de código, 2026-10-12):** no hay dashboard ni `/api/stats`. El backend loguea `room_created` con `ref` y `viaGuest`, más `player_joined` y `card_closed` (que incluye `match`). Exportás los logs de Render y `scripts/metrics-from-logs.mjs` los resume por día UTC. Sin IPs ni nombres. Se descartó `/api/stats` porque Render borra la memoria en cada spin-down: daría números chicos y engañosos, y además sumaría superficie de ataque.

> ⚠️ **No verifiqué cuánto retiene logs Render en el plan free.** Hasta saberlo: **exportá los logs una vez por semana** (agendalo, por ejemplo el domingo) o se pierden los datos. Si la retención es menor a 7 días, que sea cada 2–3 días.

| `ref` | Dónde |
|---|---|
| `tt` `ig` `yt` | Link en la bio de cada red |
| `dc` | Mensajes en Discord |
| `rd` | Reddit |
| `x` | X / Twitter |
| `twitch` | `!sala`, panel del stream y DMs a streamers |
| `wa` | WhatsApp |
| `yo` | Tus pruebas (se excluyen) |

El `?ref=` va en el link a la **landing**. El link de una sala (`/r/CODE`) no lleva ref: quien entra ahí es invitado, y eso se mide con `viaGuest` cuando después crea su sala.

| Métrica | Fuente | Umbral | Decisión |
|---|---|---|---|
| Salas por semana sin `ref=yo` | Script | ≥ 5 en S4 | Se cumple la meta. Si es < 2 en S3, el problema es de distribución: más Discord y streamers, menos clips |
| Salas por canal / horas invertidas en ese canal | Script + tu registro de horas | Comparar en S3 | Las horas de S3 y S4 van al canal ganador |
| % de salas con `viaGuest` | Script | < 5 % en S2 | El loop no funciona solo. P3 y P4 pasan a prioridad 1 del equipo de producto |
| Salas con ≥1 match / salas creadas | Script | < 50 % | Problema de producto (mazo muy largo, filtros), no de marketing. Avisar al equipo de producto antes de empujar tráfico |
| Uniones por sala | Script | Muchas en 12 | El tope duele: evaluar "modo stream" (P6) |
| Retención a 3 s y % de visualización completa por clip | Analytics nativo de TikTok, IG y YT | Comparar entre clips | Repetir el hook que más retiene |
| Errores `capacity` / `rate_limited` | Logs de Render | > 0 | Ver §7, pico viral |

## 6. SEO y buscadores con IA

**La verdad sobre "el mejor SEO del mundo":** "qué jugamos" es una frase genérica con muchísimo ruido, el sitio es nuevo y vive en un subdominio `onrender.com`. En 30 días el SEO no va a traer salas. Lo que sí conviene es dejar la base técnica hecha ahora (es barata, P2) y apuntar al long tail con la página `/juegos` (P7).

| Acción | Quién | Costo | Estado / por qué |
|---|---|---|---|
| Dominio `quejugamos.com.ar` | Agus (recuperando nic.ar) | **Cuesta plata**: el registro de nic.ar es pago, no verifiqué el monto actual | Es la palanca de SEO más grande. Con el dominio, Search Console se verifica por DNS TXT sin tocar código y `PUBLIC_ORIGIN` se cambia con una env |
| OG/Twitter image y canonical absolutas, `robots.txt`, `sitemap.xml`, `noindex` en `/r/*` y `/api/*` | Código (P2) | Gratis | **En curso.** El preview en Discord es lo que más impacto tiene a corto plazo |
| JSON-LD `WebApplication` | Código (P2.5) | Gratis | En curso, solo si no viola el CSP. No se afloja el CSP por esto |
| Search Console + Bing Webmaster Tools | Agus, con `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION` | Gratis | En curso (env opcional). Que Bing alimente a otros buscadores con IA no está verificado |
| Permitir `OAI-SearchBot` en robots.txt | Código (P2.4) | Gratis | Si se bloquea, el sitio no aparece en las respuestas de ChatGPT search ([OpenAI](https://developers.openai.com/docs/gptbot)). El robots "allow all" ya lo cubre |
| Contenido crawlable sin JS (`/juegos` con los 107 juegos) | Código (P7) | Gratis | **Diferido**, después del primer post. Google renderiza JS en una cola diferida ([Google Search Central](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)). Muchos crawlers de IA probablemente no ejecutan JS (**no verificado**) |
| `/llms.txt` | — | Gratis | **Descartado** hasta que haya evidencia de que alguien lo usa |
| Menciones reales (Reddit, README del repo, streamers) | Vos | Gratis | Los buscadores con IA citan lo que otros dicen de vos. Es una inferencia razonable, **no verificada** |

## 7. Riesgos

| Riesgo | Probabilidad / impacto | Mitigación |
|---|---|---|
| **Copyright de footage de juegos** en los clips | Media / video silenciado o bajado | El footage es de los publishers. Que el clip sea promoción no lo hace fair use, y esa doctrina es de EE.UU. En los clips: la UI de la app y caras. Gameplay poco y sin su música. Trailers de la app siempre en mute (`tiktok-kit.md` §8) |
| **Música en clips de stream** | Alta / audio silenciado | La música de Soundtrack by Twitch está licenciada **solo para el vivo**, no para clips ni VODs ([Kapwing](https://kapwing.com/resources/twitch-dmca-guidelines-what-you-need-to-know), [Slip.stream](https://blog.slip.stream/how-to-avoid-dmca-takedowns-twitch-music)). Twitch también considera de riesgo los soundtracks de juegos (fuente secundaria). Al exportar: quitar la música y poner audio de la CML en TikTok ([Soundstripe](https://www.soundstripe.com/blogs/tiktok-music-licensing-rules); no encontré la página oficial de TikTok) |
| **Reclamos de plataforma / Content ID** | Media / Short bloqueado | Un Short con un reclamo de Content ID activo puede quedar bloqueado ([Repurpose.io](https://support.repurpose.io/en/article/what-happens-if-i-repost-a-video-with-copyrighted-music-to-youtube-shorts-1qp53cg/), fuente secundaria). Mismo criterio: sin audio de terceros |
| **"Tinder" o endorsement de Steam** | Baja si se respeta / takedown | Prohibido en copy, voz y hashtags. Bio: "No afiliado a Valve ni a los publishers" |
| **Pico viral: 500 salas en total** | Baja / errores `capacity` | Si un clip pasa las ~50k vistas, mirá los logs. Un aviso de "estamos llenos, probá en un rato" es mejor que un error crudo (verificar con producto cómo se ve hoy) |
| **5 salas por IP por hora** | Media en el stream / tu PC no puede crear más | Probalo en S0. Una oficina o una red de carrier también comparten IP |
| **Cold start de ~1 min** después de 15 min sin tráfico ([Render docs](https://render.com/docs/free)) | Alta / el primer usuario cree que está roto | Comentario fijado: "si tarda, esperá un minuto". Abrir antes del stream |
| **750 horas gratis por mes por workspace**: un servicio 24/7 usa ~744 h ([Render docs](https://render.com/docs/free)) | Media si tenés otro servicio free en el mismo workspace / **Render suspende todo hasta el mes siguiente** | Revisá en el dashboard que este sea el único servicio free del workspace |
| **Retención de logs de Render** desconocida | Media / se pierden los datos de medición | Exportar cada semana (§5). Verificar la retención real en el dashboard |
| **Una sola instancia**: un reinicio o deploy borra salas en curso | Media / la sala se corta en pleno stream | No mergear a `main` durante un stream (`autoDeployTrigger: checksPass` deploya con cada merge verde): coordinalo con la sesión de código |
| Trolls en salas públicas del stream | Media / nombre ofensivo en pantalla | Moderación del chat + sala nueva. P6 |
| Caras y nombres de amigos o del chat | — / privacidad | OK de cada amigo que aparece. Tapar los nombres de Discord en las capturas |

## 8. Pedidos al equipo de producto

Todos respetan: cero deps, CSP estricta, sin IP ni tokens en métricas, y cambios de contrato = backend + frontend + mock + `docs/API.md` en el mismo PR.

| # | Pedido | Por qué | Estado (2026-10-12) |
|---|---|---|---|
| **P1** | `?ref=` con allowlist cerrada (el resto como `other`, sin ref como `direct`), se quita de la URL y se manda al crear sala. `viaGuest` vía `localStorage['quejugamos:wasGuest']`. Métricas por logs estructurados + `scripts/metrics-from-logs.mjs` | Sin esto no hay forma de saber qué funcionó | **Tomado**, rama `feat/growth-metrics-seo`. `/api/stats` descartado (memoria efímera) |
| **P2** | `PUBLIC_ORIGIN` → OG/Twitter image y canonical absolutas, `X-Robots-Tag: noindex` en `/r/*` y `/api/*`, `robots.txt` + `sitemap.xml`, JSON-LD si no viola el CSP, verificación de Google y Bing por env | Preview en Discord + higiene SEO | **Tomado**, misma rama |
| P3 | CTA "¿Jugás con otro grupo? Creá tu sala" en la pantalla de match del celu y en "La sala se cerró" | Convertir invitados en hosts (§2) | **Pendiente de pasar.** Alta si `viaGuest` < 5 % |
| P4 | Tarjeta para compartir "Esta noche jugamos X 💘" (imagen o link con su propio OG) | Cada match se convierte en un anuncio en el Discord del grupo | Pendiente de pasar. Media |
| P5 | OG específico para `/r/CODE`: "Te invitaron a votar a qué jugar" (estático, sin datos de la sala) | El link de invitación es el anuncio más visto | Pendiente de pasar. Media |
| P6 | "Modo stream": que el host pueda echar a un jugador, ocultar nombres y mostrar el código grande | Uso en vivo con chat público | Pendiente de pasar. Media, después de S2 |
| P7 | `/juegos` server-side con los 107 juegos (jugadores, plataformas, crossplay) | Long tail SEO + crawlers de IA | **Diferido** por producto, después del primer post |

## 9. Próximos pasos

| Acción | Responsable | Cuándo |
|---|---|---|
| Revisar y dar OK al deploy de `feat/growth-metrics-seo` | Agus | Antes de S1 |
| Reservar handles + bio + comentario fijado (`copy.md`) | Agus | S0 |
| Verificar en el dashboard de Render: único servicio free del workspace + retención de logs | Agus | S0 |
| Probar crear 6 salas en una hora desde tu IP (rate limit en el stream) | Agus | S0 |
| Pasar P3–P6 a la sesión de código cuando haya capacidad | Agus | S2, o antes si `viaGuest` sale bajo |
| Primer stream con amigos usando la app | Agus | S1, con P1 en prod |
| Exportar logs + correr el script + decisión de canal | Agus + Claude | Fin de S2 |

## Anexo: fuentes
- Render free tier (spin-down a los 15 min, ~1 min de cold start, 750 h por workspace): https://render.com/docs/free
- OpenAI crawlers (OAI-SearchBot / GPTBot): https://developers.openai.com/docs/gptbot
- Google — JavaScript SEO basics: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Reddit, autopromoción (guía secundaria que cita la reddiquette): https://redship.io/blog/reddit-self-promotion-rules-2026
- Ejemplos de reglas de subs: r/Games FAQ https://axebps-redlib.hf.space/r/Games/wiki/faq · r/pcgaming https://redlib.belloworld.it/r/pcgaming/wiki/selfpromotion · r/rpg_gamers https://lr.sudovanilla.org/r/rpg_gamers/comments/q3gtoj/updates_to_the_rules
- TikTok Commercial Music Library (secundaria): https://www.soundstripe.com/blogs/tiktok-music-licensing-rules
- Música de Twitch en clips/VODs (secundarias): https://kapwing.com/resources/twitch-dmca-guidelines-what-you-need-to-know · https://blog.slip.stream/how-to-avoid-dmca-takedowns-twitch-music
- Content ID en Shorts (secundaria): https://support.repurpose.io/en/article/what-happens-if-i-repost-a-video-with-copyrighted-music-to-youtube-shorts-1qp53cg/
