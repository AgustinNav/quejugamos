# Naming — ¿"GameMatch" sirve para el launch?

**Fecha:** 2026-10-09 · **Autor:** Claude (growth) · **Audiencia:** Agus (decide y publica) · **Estado:** recomendación

## TL;DR
- **"GameMatch" no conviene como marca pública.** Hay al menos 3 productos con ese nombre en el mismo rubro (gaming + "matching"), uno de ellos **en español** y con dominio `.app`; `gamematch.com` está registrado. Riesgo de confusión alto, cero chance de ganar búsquedas.
- **Recomendación: `Swipeamos`** (backup: `JugaMatch`). Ambos con `.com`, `.app` y `.com.ar` sin DNS al 2026-10-09.
- Esto **no es un trademark clearance**. Antes de imprimir nada: buscar en INPI Argentina (clases 9 y 42) y en USPTO, y reservar los handles de TikTok/IG a mano (no pude verificarlos: los perfiles requieren login).

## 1. ¿Quién ya usa "GameMatch"?

| Quién | Qué es | Riesgo de confusión | Fuente |
|---|---|---|---|
| Web "GameMatch" (español) | Plataforma para encontrar gente con quien jugar (filtros por país, idioma, plataforma, Discord) | **Alto**: mismo idioma, mismo público, misma promesa "match + juegos" | [Genbeta](https://www.genbeta.com/web/esta-pagina-web-te-ayudara-a-encontrar-gente-con-la-que-jugar-a-videojuegos) |
| `gamematch.app` | Sitio activo con título *"GameMatch - Encuentra tu compañero de juego ideal"* (DNS en un parking de hosting) | **Alto**: el dominio obvio para nosotros ya está tomado con un producto equivalente | Verificado con `curl` el 2026-10-09 |
| GameMatch (Rumania) | Plataforma de descubrimiento de juegos mobile, ~13 personas | Medio: otro mercado, pero mismo rubro | [Latka](https://www.getlatka.com/companies/gamematch), [CB Insights](https://www.cbinsights.com/company/gamematch/alternatives-competitors) |
| GAMEMATCH (Japón) | Empresa detrás de la app GameSpace (buscar compañeros de juego) | Bajo-medio | [BCN Retail](https://www.bcnretail.com/news/detail/20210401_219656.html) |
| `gamematch.com` | Dominio registrado (NS en UltraDNS), devuelve 403 | Dominio no disponible | `Resolve-DnsName` 2026-10-09 |

**Trademark:** no encontré un registro de "GAMEMATCH" en las búsquedas web, pero eso **no prueba que no exista** — las bases de USPTO/INPI no se indexan bien. Hay marcas cercanas registradas/pedidas para "matching de gamers" (LFGAMERS registrada, GAMEPAL pedida), lo que muestra que el espacio está poblado ([Justia — LFGAMERS](https://trademarks.justia.com/owners/looking-for-gamers-2760756), [GameTree](https://marlvel.ai/apps/gametree-find-gaming-friends), [Gameram](https://gameram.com)). Para software, se buscan las clases 9 y 42 juntas ([Gerben Law](https://www.gerbenlaw.com/?p=81)).

**Conclusión:** no es un tema legal urgente (no monetizamos y no encontré una marca registrada idéntica), es un tema de **producto**: si alguien busca "GameMatch" después de ver el TikTok, encuentra a otro.

## 2. Reglas de naming (no negociables)
- **Nunca "Tinder"** — en nombre, copy, hashtags ni texto en video. Decir "swipe" / "deslizá".
- **No sugerir endorsement** de Steam/Valve ni de los publishers: nada de "Steam" en el nombre, ni logos de juegos en el avatar. Footer/bio: *"No afiliado a Valve ni a los publishers de los juegos."*
- Corto (≤ 10 letras), pronunciable en rioplatense, que el nombre **diga la acción**.

## 3. Alternativas

Método de chequeo (2026-10-09): `Resolve-DnsName` sobre `.com`, `.app`, `.com.ar` (NXDOMAIN = sin DNS → **probablemente** libre, no garantizado) + búsqueda web de apps con el mismo nombre.

| # | Nombre | Por qué funciona | Dominios | Apps con el mismo nombre | Veredicto |
|---|---|---|---|---|---|
| 1 | **Swipeamos** | Spanglish natural ("¿lo swipeamos?"), describe la mecánica sin decir Tinder, el "-amos" es grupal | `.com` ✗DNS · `.app` ✗DNS · `.com.ar` ✗DNS | No encontré ninguna | **Parece libre** |
| 2 | **JugaMatch** | Continuidad con "GameMatch", pero en castellano y distinguible | `.com` ✗DNS · `.app` ✗DNS · `.com.ar` ✗DNS | No encontré ninguna | **Parece libre** |
| 3 | **¿Qué Jugamos?** | Es literalmente la pregunta del grupo de Discord. Máxima claridad | `.com` ✗DNS · `.app` ✗DNS · `.com.ar` ✗DNS | No encontré app con ese nombre exacto (la búsqueda devuelve apps tipo "¿Qué prefieres?") | **Parece libre**, pero es frase genérica: imposible de registrar como marca y pésima para búsquedas |
| 4 | **Matcheamos** | Muy rioplatense | `.com` **ocupado** (agencia de reclutamiento) · `.app` ✗DNS · `.com.ar` ✗DNS | En Argentina "¿Matcheamos?" ya se usa en prensa **asociado a Tinder** ([Infonegocios](https://infonegocios.info/default/matcheamos-like-superlike-los-numeros-de-tinder-en-argentina)) | **Ocupado (.com)** + connotación de app de citas → descartar |
| 5 | **SquadSwipe** | Inglés gamer, describe grupo + mecánica | `.com` **ocupado** (registrado, NS en DNSimple, deploy vacío en Vercel) · `.app` ✗DNS | No encontré app publicada (solo aparecen "SwipeMatch" genéricos) | **Ocupado (.com)**, `.app` parece libre |

## 4. Recomendación

**`Swipeamos`**, con el tagline *"Deslizá, matcheá, jugá."*

| Criterio | Swipeamos | JugaMatch | GameMatch (actual) |
|---|---|---|---|
| Diferenciable en búsqueda | Sí | Sí | No (3+ homónimos) |
| Dice qué hace | Sí (swipe en grupo) | Más o menos | Más o menos |
| Suena a LatAm | Sí | Sí | No |
| Riesgo "Tinder-adjacent" | Bajo (swipe es genérico) | Bajo | Bajo |
| Dominios | `.com`/`.app`/`.com.ar` sin DNS | ídem | `.com` y `.app` ocupados |

**Trade-off honesto:** "Swipeamos" es difícil de escribir para alguien que lo escuchó en voz alta (¿suaipeamos?). Mitigación: siempre mostrarlo escrito en el video y en la bio. Si eso te molesta, `JugaMatch` es el backup sin ese problema.

**Hoy en el código el servicio de Cloud Run se llama `gamematch`.** Cambiar el nombre visible no obliga a renombrar el servicio; la URL `*.run.app` igual no es memorable — por eso conviene un dominio propio.

## 5. Próximos pasos (Agus)
| Acción | Cuándo |
|---|---|
| Buscar "Swipeamos" y "JugaMatch" en [INPI Argentina](https://www.argentina.gob.ar/inpi) y USPTO Trademark Search (clases 9 y 42) | Antes del primer post |
| Reservar `@swipeamos` en TikTok, Instagram y Discord (o el backup) | Mismo día que se decide |
| Comprar el dominio elegido (`.app` exige HTTPS, Cloud Run ya lo da) | Antes de F4 |
| Sacar "Tinder de juegos" del `README.md` (hoy la primera línea lo dice) — **fuera de mi scope, lo marco** | Antes de hacer público el repo |

## Decisión final (2026-10-09)

**Nombre elegido por Agus: "¿Qué Jugamos?"** (slug `quejugamos`).

- A favor: es literalmente la pregunta que se hace el grupo; cero explicación necesaria.
- Riesgo aceptado: frase genérica → **no registrable como marca** y con mucho ruido en búsquedas. La protección real son el dominio y los handles.
- Acciones pendientes (Agus, antes del primer post): reservar dominio (`quejugamos.app` / `.com.ar`) y handles `@quejugamos` (o variante) en TikTok e Instagram. En los guiones, `[nombre]` = "¿Qué Jugamos?".
