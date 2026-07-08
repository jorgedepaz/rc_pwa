# CLAUDE.md — rc_pwa

Contexto para retomar el proyecto en futuras sesiones.

## Qué es
PWA que actúa como **control remoto BLE** para un tablero marcador de fútbol
físico basado en **ESP32**. La PWA solo envía comandos; el ESP32 recibe por
**Nordic UART Service (NUS)** y dispara el RF 433 MHz hacia el tablero.

Estado: **funcional y verificado** en Android (Chrome), PC (Chrome), macOS y
**Bluefy (iOS)**. El usuario dio por buena la funcionalidad; los próximos
cambios probablemente serán **estéticos**, no funcionales.

## Stack
- **Vite + Vanilla TypeScript** (sin framework) + **vite-plugin-pwa** (Workbox).
- Sin dependencias de runtime. `@types/web-bluetooth` para tipos.
- Deploy: **GitHub Pages** vía `.github/workflows/deploy.yml` (push a `main`).
  - URL: https://jorgedepaz.github.io/rc_pwa/
  - Requiere Pages → Source = **GitHub Actions** (ya configurado en el repo).
- **`base: '/rc_pwa/'`** en `vite.config.ts`. Si cambia el nombre del repo,
  actualizar `base` y `scope` del manifest.

## Comandos
```bash
npm install
npm run dev       # localhost:5173 (contexto seguro para Web Bluetooth)
npm run build     # tsc + vite build -> dist/ (genera sw.js + manifest)
npm run preview -- --port 4173   # sirve dist/ bajo /rc_pwa/
```
Verificación headless usada en esta sesión: Playwright (`chromium`) cargando
`http://localhost:4173/rc_pwa/` para comprobar render del teclado y ausencia de
errores de consola. **No hay tests automatizados.** El BLE real requiere el
ESP32 físico + teléfono; no es testeable en CI.

## Arquitectura
```
src/
├── main.ts    # bootstrap: registra SW, monta UI, restore()+auto-connect
├── ble.ts     # BleController: toda la lógica BLE y de reconexión
├── ui.ts      # render del teclado, barra de estado, handlers
└── style.css  # layout 100dvh pantalla completa, botones grandes
public/         # iconos PWA (192/512/maskable/apple-touch) + favicon.svg
```

### Protocolo del firmware (fijo, no cambiar sin tocar el ESP32)
- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX (write, app→ESP32): `6e400002-...`  ·  TX (notify, ESP32→app): `6e400003-...`
- Nombre BLE: `TableroRF` (se filtra por `namePrefix: 'Tablero'`).
- Comandos (string ASCII a RX): `BTN_1 BTN_3 BTN_4 BTN_6 BTN_7 BTN_9`,
  `BTN_HASH` (#), `BTN_STAR` (*), `BTN_LA/LB/LC/LD` (A/B/C/D).
  Config: `CFG_R:n`, `INFO`, `HELP`. El ESP32 responde ACK corto por TX.
- El ESP32 maneja el toggle A/B internamente; la app solo manda `BTN_x`.

### Teclado (ui.ts, `KEYS`)
Rejilla de 3 columnas, se llena fila por fila. Orden deseado por columnas:
**col1 = 1 4 7 \***, **col2 = 3 6 9 #**, **col3 = A B C D**.
→ array en orden: `1 3 A / 4 6 B / 7 9 C / * # D`.

## Decisiones clave de BLE (ble.ts) — leer antes de tocar reconexión
Estas resolvieron bugs reales; no revertir sin entender el porqué:

1. **Single-flight (`connecting`) + estado deseado (`wantConnected`).**
   Había un bucle infinito de reconexión en móvil porque `gattserverdisconnected`,
   `visibilitychange` y el auto-connect lanzaban `gatt.connect()` en paralelo.
   Ahora esos eventos solo *piden* reconectar; `ensureConnected()` serializa.
   Un único temporizador de backoff (500ms→8s).

2. **Compatibilidad iOS (Bluefy / extensión WebBLE de Safari).**
   - `requestDevice` usa **un solo filtro** `{ namePrefix: 'Tablero' }` +
     `optionalServices: [SERVICE_UUID]`. Un filtro con varias entradas rompe los
     polyfills de iOS → error `"was not offered to this origin"`.
   - Se marca `deviceFromPicker` (selector) vs memoria (`getDevices()`). En iOS
     los dispositivos de `getDevices()` se listan pero **no siempre se pueden
     conectar**; si un dispositivo de memoria falla, se **olvida** (`forgetDevice`)
     y la UI vuelve a "Emparejar" en vez de quedar pegada en "Conectar".
   - `isPermissionError()` detecta `SecurityError`/`NotAllowedError`/"was not
     offered". `shouldForget()` = permiso inválido **o** vino de memoria.
   - `pair()` reintenta la conexión hasta 3× con 400ms (Bluefy a veces rechaza
     la conexión inmediata tras elegir en el selector).

3. **Reconexión al desbloquear:** listener `visibilitychange` (visible) +
   `gattserverdisconnected` con backoff. Cubre el corte de BLE al bloquear.

## Pendiente / ideas futuras
- Cambios **estéticos** (el usuario los pedirá): colores, tamaños, tema, layout.
  El CSS usa variables en `:root` en `style.css` — buen punto de entrada.
- Si algún día Bluefy dejara de funcionar o se quisiera app nativa iOS más
  robusta: empaquetar con **Capacitor** + `@capacitor-community/bluetooth-le`
  (reutiliza UI/lógica, solo cambia la capa de transporte BLE). No es necesario
  hoy: Bluefy funciona.
- No hay control de `CFG_R` (repeticiones) en la UI; existe en el firmware.
  Podría añadirse un panel de ajustes si se pide.

## Notas de sesión
- El firmware del ESP32 (código Arduino) lo aportó el usuario en la 1ª sesión;
  no vive en este repo, es referencia.
- Deploy fallaba al inicio por Pages sin activar (Source ≠ GitHub Actions), no
  por el código. Ya resuelto.
