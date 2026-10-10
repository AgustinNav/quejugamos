# ¿Qué Jugamos? — Deploy en Render (free, USD 0 garantizado)

**Fecha:** 2026-10-09 · **Audiencia:** Agus (owner)
**Objetivo:** publicar la app sin poder gastar ni un peso, en ~15 minutos.

## TL;DR

1. Crear cuenta en Render **con GitHub y sin cargar tarjeta**.
2. *New → Blueprint* → elegir el repo `AgustinNav/quejugamos` → *Apply*. El `render.yaml` arma todo.
3. Abrir la URL `https://quejugamos.onrender.com` (o la que asigne Render), crear una sala y mirar el log `proxy_headers` para calibrar el rate limit (paso 4).

## Por qué es USD 0 *garantizado*

- **Sin medio de pago, Render no puede cobrar:** si te pasás de algún límite, suspende los servicios free hasta el mes siguiente ([render.com/docs/free](https://render.com/docs/free)).
- **La regla que importa: no cargues tarjeta en Render.** Si algún día la cargás, Render empieza a cobrar algunos excedentes, como el ancho de banda, en vez de suspender.
- 750 horas de instancia por mes, y estar prendido 24/7 son 744 h.
- El egress es mínimo: los trailers y las imágenes los baja el navegador directo del CDN de Steam, no pasan por Render.

## Lo que hay que saber del plan free

| Comportamiento | Impacto | Mitigación |
|---|---|---|
| Se apaga tras 15 min sin requests **entrantes** | La primera persona espera **~1 min** mientras arranca | Abrir el link un minuto antes de la juntada |
| SSE (server → celular) **no** cuenta como tráfico entrante | Podría apagarse en plena votación y perder la sala | El frontend hace ping cada 4 min **solo con la pestaña visible** (`public/js/keepalive.js`) |
| Reinicios cuando Render quiera | Se pierden las salas en memoria | Los clientes muestran "La sala se cerró". Es aceptable para salas de una noche |
| Builds: minutos limitados por mes | Sin tarjeta, al pasarte se frenan los deploys nuevos, pero lo deployado sigue andando | Deploy solo cuando el CI pasa (`autoDeployTrigger: checksPass`) |

## 1. Cuenta

1. https://dashboard.render.com/register → *Sign up with GitHub*.
2. **Si te ofrece cargar un método de pago, salteálo.**
3. Autorizá a Render a leer el repo `AgustinNav/quejugamos`. Alcanza con dar acceso a ese repo solo, no a todos.

## 2. Deploy con el Blueprint

1. Dashboard → **New → Blueprint**.
2. Elegí `AgustinNav/quejugamos`. Render lee `render.yaml`: servicio web `quejugamos`, Docker, plan `free`, región `virginia`, health check en `/healthz`.
3. **Apply**. El primer build tarda unos minutos.
4. Cuando el servicio esté *Live*, abrí la URL `*.onrender.com`.

## 3. Verificar

```bash
curl -s https://<tu-servicio>.onrender.com/healthz
```

Tiene que responder `{"ok":true}`. Después probalo en serio: creá una sala en la PC, entrá desde el celular con 4G (no por wifi, así es otra IP) y votá un par de juegos.

## 4. Calibrar el rate limit (una sola vez, importante)

El rate limit identifica a cada usuario por IP usando `X-Forwarded-For`. Render no documenta cuántos proxies agregan entradas a ese header. Si el número está mal, pasa una de dos cosas:

- **Muy bajo:** todos los usuarios comparten una "IP" y el límite de 5 salas por hora pasa a ser **global**. El lanzamiento se rompe.
- **Muy alto:** se toma una entrada que el cliente puede falsificar y el rate limit se puede saltear.

Cómo calibrarlo:

1. En Render → servicio → **Environment**, poné `LOG_PROXY_HEADERS=1` (el default de `render.yaml` es `0` porque el log incluye IPs). Después creá una sala **desde el celular con 4G**.
2. En Render → servicio → **Logs**, buscá la línea `proxy_headers`:
   ```json
   {"event":"proxy_headers","forwardedFor":["<IP del celu>","<IP de Render>"],"resolvedIp":"..."}
   ```
3. Buscá tu IP pública real (la del celu en 4G; la ves en https://ifconfig.me desde el celu) dentro de `forwardedFor` y contá su posición **desde la derecha**, empezando en 1. Ese número es `TRUSTED_PROXY_HOPS`.
   - Si tu IP es la última entrada → `1`, que es el valor actual: no hay que cambiar nada.
   - Si es la anteúltima → `2`.
4. En Render → servicio → **Environment**: poné ese valor en `TRUSTED_PROXY_HOPS`. Guardá y Render redeploya solo.
5. Repetí el paso 1 para confirmar que `resolvedIp` ahora es tu IP.
6. **Chequeo de spoofing** (con `LOG_PROXY_HEADERS=1` todavía prendido): mandá un `X-Forwarded-For` falso y confirmá que el server no lo usa.
   ```bash
   curl -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 6.6.6.6' \
     -d '{"hostName":"Test"}' https://<tu-servicio>.onrender.com/api/rooms
   ```
   En la línea `proxy_headers` de ese request, `resolvedIp` **no** puede ser `6.6.6.6`: tiene que ser tu IP real. Si es `6.6.6.6`, `TRUSTED_PROXY_HOPS` está alto y el rate limit se puede saltear: bajalo y repetí.
7. Volvé `LOG_PROXY_HEADERS` a `0`, para no dejar IPs en los logs.

> **El Blueprint está en sync manual:** cambiar `render.yaml` no toca las env vars del servicio ya creado. `TRUSTED_PROXY_HOPS` y `LOG_PROXY_HEADERS` se cambian a mano en **Environment**. En particular, un servicio creado cuando el default era `LOG_PROXY_HEADERS=1` sigue en `1` hasta que lo pases a `0` en el dashboard.

## 5. Deploys siguientes

Push a `main`, GitHub Actions corre los tests y el smoke test de Docker, y si pasan, Render deploya solo (`autoDeployTrigger: checksPass`). Para deployar a mano: servicio → **Manual Deploy**.

## 6. Logs y rollback

- **Logs:** servicio → **Logs**. La app escribe JSON con `severity` y eventos como `room_created`, `card_closed` (con `match`), `room_expired` y `error`.
- **Rollback:** servicio → **Events**, elegís un deploy anterior y le das **Rollback**.

## 7. Dominio propio (opcional)

Servicio → **Settings → Custom Domains**. Render emite el certificado TLS gratis. El dominio lo pagás aparte en el registrador, así que esto sí cuesta plata (un `.com.ar` en NIC Argentina es barato, pero no es USD 0). Sin dominio propio, la URL `*.onrender.com` sirve igual.

## Plan B

Si Render free deja de alcanzar, por cold starts que molestan o mucho tráfico, el plan B es Cloud Run: `docs/DEPLOY-CLOUDRUN.md`. Ese camino **requiere tarjeta y no garantiza USD 0**.
