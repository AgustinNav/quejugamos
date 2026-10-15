# Comentarios y valoraciones globales de juegos — opciones de diseño

**Fecha:** 2026-10-14 · **Autor:** Claude (diseño) para Agus · **Versión:** 1.0 · **Audiencia:** Agus (decide) · **Estado:** propuesta, sin código

## TL;DR

- **Pedido:** que los usuarios dejen comentarios globales sobre juegos, que otros vean y voten (👍/👎) para ordenarlos por relevancia.
- **Lo difícil no es el código: es que hoy no hay nada persistente, nada público y nada moderable.** Hoy todo vive en memoria, se borra con la sala y el único dato personal son los nombres de jugador.
- **Recomendación:** **A → B, y C solo si hay demanda.** A = agregado 👍/👎 por juego derivado de los votos reales de las salas (cero texto, cero moderación). B = tags predefinidos ("ideal para 2", "difícil") votados al terminar la sala. C (texto libre) cuesta 30–60 min/semana de moderación y riesgo legal, para una meta de 5 salas/semana que no lo necesita.
- **Storage:** con USD 0 garantizado, el candidato es **Cloudflare D1 por REST** (tope duro verificado: las consultas fallan, no se cobra) o **Neon** (sin tarjeta verificado). Ambos con `fetch` nativo, sin dependencias. La app debe seguir funcionando si la base se cae (*fail-open*).
- **Advertencia de producto:** un "like" en una sala significa "quiero jugarlo esta noche con este grupo y estos filtros", no "el juego es bueno". Rotularlo como **popularidad** ("73 % lo quiso jugar, 41 salas"), no como calidad.

## 1. Qué implica frente a hoy

| Hoy | Con comentarios globales | Consecuencia |
|---|---|---|
| Estado en un `Map`; un deploy o spin-down de Render lo borra | Datos que sobreviven meses | Hace falta una base **externa** (Render free no tiene disco persistente) |
| Nada es público; todo es de miembros de la sala | Contenido de usuarios visible para desconocidos | Moderación, takedown, términos |
| Datos personales: nombres, en memoria, borrados con la sala | Algo persistente y público | Revisar Ley 25.326 si se guarda algo identificable (§4) |
| Sin cuentas: el token vale solo para su sala | Votar "relevancia" sin identidad | Anti-manipulación por membresía de sala y rate limit (§3) |
| Cero dependencias, una instancia | Un servicio externo en el camino | `fetch` nativo + *fail-open* + cache en memoria |

## 2. Opciones de storage (relevadas el 2026-10-14)

Criterio: USD 0 **garantizado** = sin tarjeta cargada y tope duro que corta en vez de cobrar.

| Opción | Límites free | ¿Tarjeta? | Al pasarse del límite | Auth / uso con `fetch` | Latencia desde Render Oregon |
|---|---|---|---|---|---|
| **Cloudflare D1** (REST) | 5 M filas leídas/día, 100 k escritas/día, 5 GB | No verificado (la página de pricing no lo dice) | **Las consultas fallan** hasta 00:00 UTC; datos intactos. Vigente desde 2026-09-01 ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)) | `POST /accounts/{id}/d1/database/{id}/query` con `{sql, params}`; API token Bearer con permiso D1 Write ([API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)). Secreto en env de Render | No verificado. Es la API pública de Cloudflare, no un binding: esperable más lento; cachear |
| **Neon** (Postgres) | 1 GB/proyecto, 100 CU-h, 5 GB egress | **No** ([pricing](https://neon.com/pricing)) | Sin CU-h/egress: se **suspende el cómputo**; sin storage: **se bloquean escrituras**. No borra datos | SQL-over-HTTP: no verificado. Suspende a los 5 min de inactividad (cold start de la DB: no medido) | No verificado |
| **Turso** (libSQL) | 5 GB, 500 M lecturas/mes, 10 M escrituras/mes | **No** ([pricing](https://turso.tech/pricing)) | **No verificado.** Los overages son opt-in y exigen tarjeta, así que sin tarjeta no deberían cobrar | La doc de API que leí remite al SDK; endpoint HTTP de consultas: no verificado | No verificado |
| **Supabase** (PostgREST) | 500 MB, 5 GB egress, API sin límite de requests; **pausa el proyecto tras 1 semana sin actividad** ([pricing](https://supabase.com/pricing)) | No verificado | No verificado | REST estándar (conocimiento general, no verificado hoy) | No verificado |
| **Upstash Redis** (REST) | 500 k comandos/mes, 250 MB ([pricing](https://upstash.com/pricing/redis)) | No verificado (agregar tarjeta lo pasa a pay-as-you-go) | No verificado | REST + token | No verificado |
| **Firestore** (Spark) | 1 GiB, 20 k escrituras/día, 50 k lecturas/día; "No payment method needed" ([pricing](https://firebase.google.com/pricing)) | No | Según fuentes de terceros las operaciones fallan hasta el reset; no verificado en doc oficial. Crear Firestore en proyecto nuevo sin Blaze: no verificado | REST + auth de Google (JWT de service account, más pesado) | No verificado |

**Lectura:** D1 y Neon son los únicos con tope duro **documentado** hoy. D1 gana por modelo de consumo (por fila, no por tiempo de cómputo), sin suspensión por inactividad y con una API de una sola llamada. **Primer paso antes de comprometerse:** crear la cuenta y confirmar que no pide tarjeta (el único dato crítico no verificado). Plan B: Neon.

**Volumen real:** A escribe ~1 fila por carta cerrada (≈20 por sala); a 5–50 salas/semana son cientos de escrituras/semana, órdenes de magnitud bajo el límite. Las lecturas las absorbe un cache en memoria (refresh cada ~10 min).

## 3. Moderación y abuso sin cuentas

| Amenaza | A (👍/👎 derivado) | B (tags fijos) | C (texto libre) |
|---|---|---|---|
| Spam, links, insultos | No existe | No existe | Filtros (links, listas de palabras, largo ≤ 140) + reportes + **retener antes de publicar** |
| Contenido ilegal | No existe | No existe | Real: hay que poder bajarlo en horas |
| Suplantación ("soy el dev de X") | No existe | No existe | Sin nombre visible; texto anónimo |
| Manipular el ranking | Sí | Sí | Sí, más barato |

**Anti-manipulación sin cuentas (aplica a A, B y C):**
1. **Prueba de presencia:** solo cuenta un voto de un jugador que votó ese juego en una sala. El token de miembro ya existe; la agregación la hace el servidor al cerrar la carta, no el cliente.
2. **Un voto por (sala, juego):** la sala aporta un voto agregado por juego (mayoría de sus miembros), no uno por jugador. Un atacante con 12 bots en una sala pesa lo mismo que 1 persona.
3. **Umbral:** salas con ≥ 2 jugadores distintos y ≥ 5 cartas cerradas. Mínimo de N salas para mostrar un porcentaje ("pocos datos" debajo).
4. **Rate limit por `rateLimitKey()`:** hoy son 5 salas/hora/cliente; sigue siendo el techo de inyección (≈ 120 salas/día/cliente máximo, cada una con un voto por juego).
5. **Orden por límite inferior de Wilson**, no por promedio: resiste pocos votos y manipulación chica.

Esto **no** frena a alguien con muchas IPs y paciencia; con un ranking de bajo valor, se acepta.

**Flujo mínimo de moderación (solo Agus):**

| Opción | Qué hacer | Tiempo/semana |
|---|---|---|
| A, B | Mirar logs de salas/votos anómalos; comando admin para resetear un juego | ~0–10 min |
| C | Cola de pendientes (retener todo hasta aprobar, o publicar y revisar reportes), endpoint admin protegido por secreto en env, bajas con registro | **30–60 min a 5 salas/semana; crece lineal con el tráfico** y no se delega sin cuentas de admin |

## 4. Legal y privacidad (Argentina) — **no es asesoramiento legal**

| Tema | Qué se sabe | Qué validar con un profesional |
|---|---|---|
| Datos personales (Ley 25.326, AAIP) | Si se guarda algo que identifica a una persona, el responsable puede tener que inscribir la base y cumplir seguridad, información al titular y transferencia internacional ([AAIP](https://www.argentina.gob.ar/node/53779)). Un servidor en EE. UU. activa lo de transferencia internacional | Si **A/B (solo agregados por `gameId`, sin nombres, IPs ni códigos de sala)** quedan fuera. Es el diseño recomendado justamente para no entrar |
| Contenido de usuarios (C) | No hay ley específica de intermediarios; la doctrina de la Corte ("Rodríguez c/ Google", 2014) pide en general orden judicial, salvo ilicitud manifiesta, donde basta notificación fehaciente ([CELE](https://observatoriolegislativocele.com/wp-content/uploads/informe-legislativo-17-argentina.pdf)). Estado actual de proyectos de ley: no verificado | Tu responsabilidad por texto alojado bajo tu marca; términos, aviso de contenido y proceso de baja por escrito |
| Marca | "Tinder" prohibido en copy propio; con C habría que filtrarlo también en comentarios | — |

Con C haría falta como mínimo: términos de uso de una página, un canal de contacto para bajas y un plazo de respuesta comprometido.

## 5. Opciones de producto

| | A) 👍/👎 por juego, derivado de salas | B) Tags predefinidos | C) Comentarios cortos + votos de relevancia |
|---|---|---|---|
| Qué ve el usuario | "73 % lo quiso jugar · 41 salas" en la tarjeta | Chips: "ideal para 2", "difícil", "muy divertido" con contador | Lista de comentarios ordenada por 👍−👎 |
| Esfuerzo | Medio: storage + cola de escritura + cache + endpoint + UI | A + UI de selección al terminar la sala + tabla de tags | B + moderación, reportes, admin, términos |
| Riesgo | Bajo. Mide "querer jugar", no calidad | Bajo | **Alto** (§3, §4) |
| Moderación | 0 | 0 | 30–60 min/semana |
| Valor para la meta (5 salas/semana) | Medio: motivo para volver y compartir, no capta salas nuevas | **Medio-alto**: "ideal para 2" responde la pregunta real del grupo y sirve de contenido/SEO | Bajo a corto plazo: sin masa crítica un comentario global está vacío |
| ¿Cumple el pedido literal? | Parcial (valoración sí, comentario no) | Parcial | Sí |

**Recomendación:** **A, luego B, C en pausa.** C con 5 salas/semana da pocas piezas de contenido y todo el costo operativo y legal; se reabre solo con tráfico y pedidos concretos. Rollout:

1. **Paso 0 (1 h):** crear cuenta D1, confirmar que no pide tarjeta, medir latencia desde Render.
2. **A:** backend *fail-open* con cache, endpoint de lectura, UI mínima, flag opt-in con test que lo active.
3. Medir 2–4 semanas: ¿alguien mira el dato? ¿cuánto storage/escrituras consume?
4. **B** si A se usa. **C** solo con evidencia.

## 6. Boceto de A (la recomendada)

**Modelo (D1/SQLite).** Sin nombres, códigos de sala, IPs ni tokens:

```sql
CREATE TABLE game_stats (
  game_id    TEXT PRIMARY KEY,           -- id de public/games.js
  rooms      INTEGER NOT NULL DEFAULT 0, -- salas válidas que votaron el juego
  up         INTEGER NOT NULL DEFAULT 0, -- salas con mayoría "like"
  down       INTEGER NOT NULL DEFAULT 0,
  played     INTEGER NOT NULL DEFAULT 0, -- salas con mayoría "ya lo jugué"
  updated_at INTEGER NOT NULL
);
-- B agrega: game_tags(game_id, tag, count, PRIMARY KEY (game_id, tag))
```

**Escritura (sin endpoint público):** al cerrar una carta en una sala válida (§3), el servidor encola un `UPSERT ... up = up + 1`. Cola en memoria, flush cada ~30 s y en SIGTERM; si D1 falla se descarta con log (los agregados son prescindibles). **La votación nunca depende de D1.**

**Lectura:** endpoint nuevo, estilo `docs/API.md`:

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| GET | `/api/games/stats` | — | `200 { "updatedAt": number, "games": { "<gameId>": { "rooms": n, "up": n, "down": n, "played": n, "score": number } } }`. `score` = límite inferior de Wilson de `up/(up+down)`; solo juegos con ≥ N salas. `Cache-Control: public, max-age=300` | 429 `rate_limited`, 503 `stats_unavailable` (sin datos cacheados; el cliente oculta la UI) |

Contrato en el mismo PR: backend, frontend, `tools/mock-server.mjs`, `docs/API.md`. Tests: input malformado con proceso vivo; flag activo; D1 caído (la sala sigue funcionando); reintroducir el bug y ver que el test falla.

**Cambios a `CLAUDE.md`:**

1. Costo: "storage externo solo con cuenta **sin tarjeta** y tope duro verificado; *fail-open*".
2. Privacidad: reemplazar "el único dato personal son los nombres, en memoria" por "la única persistencia externa son **agregados por `gameId`** (sin nombres, códigos de sala, IPs ni tokens); los nombres siguen solo en memoria".
3. Secreto: `D1_API_TOKEN` solo en env de Render, nunca en logs ni repo; permiso mínimo.
4. Estado: persistir agregados **no** habilita 2 instancias (las salas siguen en memoria).
5. CSP sin cambios: la llamada es servidor→Cloudflare; el navegador no habla con nadie nuevo.
6. Si algún día se activa C: sección de moderación y términos, y reevaluar "sin cuentas".

## Verificado vs. no verificado

| Verificado (2026-10-14) | No verificado |
|---|---|
| Límites y comportamiento al exceder de D1; endpoint REST de D1 | Si D1 pide tarjeta al crear la cuenta |
| Neon: sin tarjeta, qué se suspende/bloquea al excederse | Latencia Render Oregon → cualquier proveedor |
| Turso: sin tarjeta, límites | Endpoint HTTP de Turso y Neon; Turso al excederse |
| Supabase: límites y pausa a 1 semana | Tarjeta/tope de Supabase; Upstash al excederse |
| Firestore Spark: sin medio de pago, cuotas | Cold start de Neon; Firestore nuevo sin Blaze |
| Marco legal argentino general (fuentes secundarias) | Leyes de intermediarios vigentes; obligación de inscribir la base |
