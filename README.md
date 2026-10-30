# VRPose — Espejo corporal en realidad mixta (MVP)

SPA estática que muestra, en un visor **Meta Quest**, un **esqueleto virtual**
que reproduce tus movimientos en tiempo real, colocado **frente a vos como un
espejo**. La estimación de pose corre en un **celular** y solo se transmiten
coordenadas al visor por WebRTC.

> **Prototipo (MVP).** Seguimiento monocular con limitaciones conocidas (ver
> abajo). Sin física, sin juego, sin backend propio, sin cuentas.

## Arquitectura

| Pieza | Tecnología |
| --- | --- |
| Front-end | TypeScript + Vite, SPA estática (GitHub Pages) |
| Render 3D / AR | Three.js + WebXR (`immersive-ar`) |
| Pose estimation | MediaPipe **Pose Landmarker** (`@mediapipe/tasks-vision`), 1 persona |
| Señalización | **PeerJS** + **PeerServer Cloud** (servicio externo) |
| Transporte | WebRTC **DataChannel** (no reliable / no ordenado) |
| QR | `qrcode` (generación) · `jsqr` (lectura) |

**El video no se transmite por la red.** Se procesa localmente en el celular y
solo viajan landmarks (coordenadas).

### ⚠️ No es "sin servidores"

PeerJS necesita un **servidor de señalización** para negociar la conexión
WebRTC. Por defecto se usa **PeerServer Cloud** (`0.peerjs.com`), un servicio
**externo**. Esto evita retransmitir datos por un servidor en el caso común,
pero **no** es una arquitectura sin servidores: si ese servicio no está
disponible, el emparejamiento falla. Podés levantar tu propio PeerServer y
configurarlo (ver *Configuración*).

### Señalización, STUN y TURN

- **Señalización**: canal inicial (vía PeerServer) por el que los dos
  dispositivos intercambian la información para abrir el canal WebRTC directo.
- **STUN**: ayuda a cada dispositivo a descubrir su IP/puerto públicos para
  intentar una conexión **directa** (peer-to-peer). Por defecto usamos
  `stun:stun.l.google.com:19302`.
- **TURN**: servidor de **relay**. En redes con **NAT simétrico** o firewalls
  estrictos (datos móviles, wifi corporativo), la conexión directa suele
  fallar y hace falta un TURN para retransmitir el tráfico.

> **PeerJS NO incluye TURN gratuito.** Si el celular y el visor están en redes
> distintas o restrictivas, probablemente necesites tu propio TURN (p. ej.
> `coturn`). Lo ideal para probar es tener **ambos dispositivos en la misma
> wifi**.

Configurá tus servidores ICE (STUN/TURN) así (en la consola del navegador de
**cada** dispositivo, antes de emparejar):

```js
localStorage.setItem("vrpose.ice", JSON.stringify([
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:TU_HOST:3478", username: "user", credential: "pass" }
]));
```

## Desarrollo

```bash
npm install          # usa legacy-peer-deps (ver .npmrc)
npm run dev          # servidor de desarrollo (https recomendado, ver abajo)
npm run build        # typecheck + build de producción a dist/
npm run preview      # sirve el build
npm run test         # pruebas unitarias (Vitest)
npm run typecheck    # solo chequeo de tipos
```

**HTTPS en desarrollo:** la cámara (`getUserMedia`) y WebXR requieren un
contexto seguro. `localhost` cuenta como seguro, pero para probar desde el
celular/Quest por IP de la LAN necesitás HTTPS. Opciones: `vite --host` detrás
de un túnel TLS, o un plugin de certificados. GitHub Pages ya sirve por HTTPS.

## Despliegue en GitHub Pages

- El workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  construye y publica `dist/` en cada push a `main` (Pages vía GitHub Actions).
  En el repo, activá **Settings → Pages → Source: GitHub Actions**.
- **Rutas de assets:** `vite.config.ts` usa `base: "./"` (rutas relativas), así
  que funciona tanto en la raíz (`https://vrpose.github.io/`) como en un
  subpath (`https://usuario.github.io/repo/`).
- **Rutas por hash:** el router usa `#/camera`, `#/quest`, etc. Abrir un enlace
  directo (o el del QR) no da 404 porque la parte antes de `#` siempre es el
  `index.html` servido.
- **Modelo de MediaPipe:** por defecto el `.task` se descarga del hosting de
  Google y el WASM desde jsDelivr (pinneado a la versión del paquete). Para
  **auto-hospedarlo** en Pages, poné el `.task` en `public/models/` y ajustá
  `MEDIAPIPE.modelAssetPath` en [`src/config.ts`](src/config.ts) usando
  `import.meta.env.BASE_URL`.

## Uso

Pantalla inicial con dos opciones.

### 📷 Modo cámara (celular)

1. Apoyá el teléfono **de frente a vos**, estable y vertical, con el **cuerpo
   completo** visible (cabeza a pies). Alejate 2–3 m.
2. Tocá **"Permitir cámara y empezar"** (permiso explícito).
3. Elegí cámara **frontal/trasera** y, si querés, **espejá la vista**
   (es solo visual; las coordenadas transmitidas no se alteran).
4. Verás el video con el **esqueleto superpuesto** para comprobar el encuadre.
5. Se crea una sesión PeerJS y aparece un **código corto** (6 caracteres, p.
   ej. `ABC123`) para escribir en el visor. Un **punto de estado** indica si la
   sesión sigue vigente ante el servidor de señalización:
   🟢 activa · 🟡 reconectando · 🔴 caída/cerrada (se reconecta sola).
   El QR y el enlace copiable quedan como alternativa (desplegable "Otras
   formas"). El **código corto es a la vez el id del peer y el token** de la
   sesión.
6. Estados: *esperando visor → conectado → transmitiendo → conexión perdida*.
7. Métricas: **FPS de inferencia**, **Hz de envío**, **estado de conexión**,
   **visibilidad media** de articulaciones, **paquetes descartados** y aviso de
   **cuerpo fuera de encuadre**. Además, el visor devuelve por el mismo canal su
   **altura estimada** y el **RTT** que mide, que el celular muestra como
   *Altura estimada (visor)* y *RTT (visor)* (telemetría informativa; mensajes
   `status`).
8. Se intenta **mantener la pantalla encendida** (Screen Wake Lock; si no está
   disponible, simplemente no se activa).

### 🥽 Modo Quest (visor)

Métodos de emparejamiento, en orden de fiabilidad en el visor:

1. **Código corto** (recomendado): escribís los 6 caracteres que muestra el
   celular. Es el método principal porque en varios visores el acceso a la
   cámara para escanear no está disponible o abre la cámara del sistema.
2. **Pegar enlace**: pegás la URL del QR.
3. **Escanear QR** (último, puede fallar): solo si el navegador del visor
   expone una cámara utilizable y concede permiso. Si no, usás el código corto
   (la falta de cámara **no** bloquea nada). El escaneo ocurre **antes** de
   entrar en modo inmersivo.
   > WebXR **no** entrega los frames del passthrough a la página; por eso el
   > escaneo usa la cámara normal (`getUserMedia`) si existe, y en muchos
   > visores no hay una cámara utilizable para esto.
2. Al emparejar, se muestra el **estado de recepción**.
3. Botón explícito **"Entrar en realidad mixta"** → sesión WebXR
   `immersive-ar` con **fondo transparente** (passthrough).
4. Se usa un espacio de referencia con suelo (`local-floor`) cuando está
   disponible.
5. Si WebXR no está disponible, hay un **modo de depuración 3D** en escritorio
   (orbitá con el mouse) para ver el esqueleto.

## Calibración (guiada y honesta)

Distinguimos tres sistemas de coordenadas y **no** mezclamos uno por otro:

1. **Imagen** — landmarks normalizados de MediaPipe.
2. **Cuerpo** — *world landmarks* de MediaPipe (métricos, centrados en la
   cadera). Son **relativos al cuerpo**: no dan una ubicación global en la sala.
3. **Mundo** — coordenadas de la sala en WebXR, donde realmente ubicamos la
   figura.

**Dos modos de colocación** (botón *Modo* en el panel):

- **Sobre mí (primera persona)** — **modo por defecto, no espejado**. La figura
  se **ancla a tu cuerpo** y te sigue por la sala, de forma **estable**:
  - El **eje vertical se fija al "arriba" real** (gravedad, del giroscopio del
    visor): el esqueleto **nunca se invierte** (no más "pies en el techo").
  - La **orientación (yaw) se captura una sola vez** al calibrar y **se
    mantiene**: girar o inclinar la cabeza **ya no rota el cuerpo** (eso era el
    efecto "cuello ortopédico"). Mirá al frente al pulsar **D** para fijarla;
    recalibrás cuando quieras.
  - El cuerpo se **ancla horizontalmente al centro de la cadera** (el *core*,
    que es estable), no a la cabeza, así mover o girar la cabeza **no hace
    bailar los pies**. La altura de la cabeza sí se alinea con el visor, de modo
    que el **core queda siempre por debajo** cuando estás parado. Si el pose
    estimator te ve **acostado**, la figura se muestra acostada (esa inclinación
    vive en la pose articulada, no en el anclaje).
  - La posición del ancla está **suavizada (paso bajo, ~0,5 s)**: los
    movimientos rápidos de cabeza se amortiguan, pero si caminás el cuerpo te
    acompaña.
  - La **escala se calibra una sola vez** con cabeza + ambas manos (no
    continuamente, que era lo que metía ruido). Mostrá ambas manos al visor;
    recalibrás cuando quieras con **D**. La escala es invariante a la rotación,
    por eso es estable aunque muevas los brazos.
  - Ajuste fino opcional: *Escala*, *Altura*, *Adelante/atrás*. No hace falta
    marcar el celular.
- **Espejo (enfrente)**: la figura se coloca entre vos y el celular, como un
  reflejo. Usa la calibración manual (posición, celular, escala por altura).

> **Gestos en AR** (requieren *hand-tracking* activo en el visor):
> - **Pellizco mano izquierda**: muestra/oculta el panel de calibración.
> - **Pellizco mano derecha / gatillo**: marca el celular cuando está armado (B).
> - **Pellizco con ambas manos casi a la vez**: sale de realidad mixta. Funciona
>   aun si el panel (dom-overlay) no se muestra en tu visor.
>
> **Depuración de manos:** las manos detectadas por el visor se dibujan como
> **líneas de dedos** (azul = izquierda, naranja = derecha). Si no ves líneas, el
> *hand-tracking* no está activo → no habrá autocalibración ni gestos; activalo
> en los ajustes del visor.
>
> **Panel en AR:** el panel usa `dom-overlay`. Si tu visor no lo soporta, usá los
> gestos de arriba (y el botón del sistema del visor para salir como último
> recurso).

Pasos del modo espejo (controles en el panel, también dentro de AR vía
*dom-overlay*):

- **A · Posición del usuario**: guarda tu posición y orientación horizontal al
  pulsar *Calibrar*.
- **B · Celular**: marcá su posición apuntando con el **mando al piso** y
  apretando el gatillo; o usá la alternativa **manual** (distancia + dirección).
  No se infiere la posición física del celular desde el QR.
- **Plano del espejo**: la figura se coloca entre vos y el celular (a mitad de
  distancia por defecto), **orientada hacia vos** y con orientación **fija** tras
  calibrar (no sigue cada giro de cabeza). Ajustás distancia, lateral, altura,
  escala y rotación.
- **D · Escala y suelo**: parado unos segundos con ambos pies visibles, pulsá
  *Capturar escala* e ingresá tu **altura real**. Se fija una **referencia de
  suelo calibrada**; **no** se re-nivela el esqueleto en cada frame (eso
  eliminaría saltos y elevaciones de rodilla).
- **E · Espejo**: la reflexión se aplica en el **sistema del espejo** (negando
  el eje X local), no intercambiando etiquetas izquierda/derecha. Verificación
  guiada: *"levantá la mano derecha"*; si quedó doblemente espejado, usá
  *Corregir espejo*.

## Rendimiento

- Inferencia (celular) y render (Quest) están en **dispositivos distintos**: la
  separación es inherente. El Quest **no** corre inferencia, solo dibuja la
  última pose recibida, con render desacoplado de la red.
- En el celular, la inferencia se **limita en frecuencia** (configurable,
  ~15–30 Hz) para no bloquear la UI. *Pendiente:* mover la inferencia a un **Web
  Worker** (`detectForVideo` es síncrono).
- Envío con **control de frecuencia** y **backpressure** (se descarta un frame
  si el buffer del DataChannel supera un umbral: interesa la pose más reciente).
- Geometrías/materiales **reutilizados** en el render del esqueleto.
- Al salir se **liberan** cámara, conexiones, modelo y recursos de WebGL.

### Protocolo

Mensajes tipados y versionados: `HELLO` / `HELLO-ACK`, `POSE`, `CALIBRATION`,
`STATUS`, `PING` / `PONG`, `RESET`. Cada `POSE` incluye versión, **secuencia**,
**timestamp de captura**, dimensiones/orientación del video, landmarks
normalizados y *world landmarks* (con visibilidad cuando la API la da).

- **Cola acotada**: se guarda solo la **pose más reciente**; se **rechazan**
  paquetes con secuencia menor/igual o timestamp más viejo (defensa ante
  reordenamientos del transporte no ordenado).
- **Transporte**: DataChannel **no fiable / no ordenado** (`reliable: false`)
  para evitar bloqueo por paquetes obsoletos; la frescura se garantiza en el
  receptor con secuencia + timestamp, nunca por el orden del transporte.
- **Tiempo**: los relojes de los dos dispositivos **no** están sincronizados.
  Mostramos **RTT** (medido con ping/pong en un solo reloj) y **antigüedad
  local** desde la recepción. **No** calculamos latencia unidireccional
  restando timestamps de dispositivos distintos. (Hay un estimador opcional de
  *offset* de reloj estilo Cristian, con incertidumbre ±RTT/2, documentado en
  `src/protocol/clock.ts`, pero **no** se presenta como medición exacta.)

## Limitaciones conocidas (seguimiento monocular)

- Una sola cámara RGB **no** da profundidad métrica estable. No prometemos
  *tracking* preciso en profundidad: la figura se mantiene cerca del plano del
  espejo.
- Los *world landmarks* están **centrados en el cuerpo**: no permiten inferir
  por sí solos la **traslación global** de la pelvis. El desplazamiento lateral
  es una **estimación aproximada** derivada de landmarks de imagen y la escala
  de calibración (activable, y declarada como aproximada).
- Priorizamos **pose articulada**, inclinación de tronco, flexión de rodillas,
  elevación de piernas y movimiento lateral aproximado.
- Articulaciones de **baja confianza**: no se reemplazan por el origen; se
  **atenúan** o se mantienen brevemente, y los segmentos inválidos se **ocultan**.
- Sin datos frescos, el esqueleto se **atenúa** y se muestra desconexión; no
  queda congelado como si estuviera activo.

## Validación

### ✅ Verificado automáticamente (en este entorno)

- `npm run typecheck` sin errores (TypeScript estricto).
- `npm run test` — 32 pruebas en 4 archivos, enfocadas en:
  - **transformaciones de coordenadas** y construcción del plano/espejo
    (`tests/transforms.test.ts`);
  - **reflexión** (involutiva, puntos del plano fijos, componente normal
    negada);
  - **validación de paquetes** entrantes (`tests/validate.test.ts`);
  - **rechazo de datos viejos** / fuera de orden (`tests/queue.test.ts`);
  - **parseo de emparejamiento** por URL/código (`tests/pairing.test.ts`).
- `npm run build` genera un bundle con **code-splitting por modo** (el celular
  no descarga Three.js; el visor no descarga el loader de MediaPipe).

### ⏳ Pendiente de validar en hardware real (sin acceso físico aquí)

No se verificó en un Meta Quest ni en un celular reales. Falta comprobar **en
dispositivos**:

1. Emparejamiento real entre dos dispositivos (y sobre redes con NAT/TURN).
2. *Fallback* manual cuando el Quest no puede leer el QR.
3. Entrada a `immersive-ar` con passthrough y `dom-overlay` en Quest Browser.
4. Esqueleto ubicado correctamente entre usuario y celular.
5. Escala corporal razonable y referencia de suelo estable.
6. Comportamiento espejo correcto (prueba "mano derecha").
7. Elevar un pie sin desplazar artificialmente todo el cuerpo.
8. Manejo de pérdida de articulaciones y de desconexión en vivo.
9. Funcionamiento bajo la subruta de GitHub Pages.
10. Ausencia de transmisión de video (inspección de red en vivo).

## Estructura

```
src/
  config.ts            configuración y overrides (ICE, Hz, modelo)
  router.ts            router por hash
  main.ts              bootstrap + carga diferida por modo
  protocol/            mensajes tipados, validación, cola, reloj/RTT
  math/                transforms (coordenadas, reflexión, escala), smoothing
  pose/landmarks.ts    topología de 33 landmarks de MediaPipe
  camera/              modo celular: cámara, MediaPipe, overlay, wake lock
  quest/               modo visor: WebXR, esqueleto, mapeo de pose, calibración
  net/peer.ts          wrapper de PeerJS (señalización + DataChannel)
  ui/                  helpers de DOM, QR, pantalla inicial
tests/                 pruebas de Vitest
```

## Notas de versiones

Se verificaron las APIs actuales antes de implementar y se eligieron versiones
compatibles: `three` 0.187, `@mediapipe/tasks-vision` 1.2, `peerjs` 1.5.5,
`vite` 7, `typescript` 5.9, `vitest` 4. No se inventaron APIs de WebXR,
MediaPipe ni PeerJS.
