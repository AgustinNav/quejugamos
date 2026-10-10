# GameMatch 🎮💘

Tinder de juegos para elegir a qué jugar con amigos. Pensado para compartir pantalla por Discord y votar entre todos.

## Correr

```bash
npm start
```

Abrir http://localhost:3000. Sin dependencias (Node 18+).

- `PORT=4000 npm start` → otro puerto
- `STEAM_CC=us npm start` → precios de otra región de Steam (default `ar`)
- `HOST=0.0.0.0 npm start` → exponer en la red (por defecto solo escucha en `127.0.0.1`)

## Seguridad

Allowlist de juegos en el proxy de Steam, rate limit por IP (120 req/min), solo GET/HEAD, CSP + `nosniff` + `Referrer-Policy`, SRI en hls.js, y cualquier input malformado (URL, Host) responde 4xx en vez de tumbar el proceso.

## Cómo se usa

1. Cargar los nombres de los amigos (hasta 9) y filtros (plataforma, precio máx, que entren todos).
2. Por cada juego cada uno vota 👍/👎. Teclas `1`–`9` ciclan el voto de cada jugador (nada → like → nope).
3. `→` / `Enter` = siguiente, `←` / `Backspace` = deshacer, `M` = sonido del trailer.
4. Arrastrar la tarjeta a la derecha/izquierda completa con like/nope a los que no votaron.
5. Si votan todos like → **IT'S A MATCH**. `🏆 Resultados` muestra el ranking.

## Datos

- `public/games.js`: catálogo curado (pitch, jugadores, plataformas, crossplay). Para agregar un juego de Steam, sumá una entrada con su `steamId` (el número en la URL de la tienda).
- Precio, trailer, capturas y reseñas vienen en vivo de la API de Steam vía `/api/steam/:id` (cache de 6 h en `.steam-cache.json`).
- Plataformas y crossplay son datos cargados a mano: los marcados "verificar" no están confirmados.
