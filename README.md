# Tablero RF — Control Remoto (PWA)

PWA que actúa como control remoto inalámbrico del tablero marcador de fútbol
basado en **ESP32 + BLE** (firmware "Clon RF 433"). Replica el control físico:
teclado `1 3 4 6 7 9 # * A B C D`, y cada tecla envía su comando (`BTN_1`,
`BTN_HASH`, `BTN_LA`, …) por el **Nordic UART Service**.

## Características
- **100% offline** tras la primera carga (service worker + precache).
- **Instalable** a pantalla completa desde el icono.
- **Emparejamiento único** y **reconexión de un toque** (recuerda el tablero).
- **Reconexión automática** al desbloquear el teléfono.
- Coexiste con audio Bluetooth clásico (BLE independiente).

## Compatibilidad
- **Android:** Chrome o Edge (Web Bluetooth nativo). ✅ Recomendado.
- **iPhone/iPad:** Safari **no** soporta Bluetooth Web. Abre la página con el
  navegador **[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)**.
- Requiere **HTTPS** (por eso GitHub Pages). En local funciona en `http://localhost`.

## Desarrollo
```bash
npm install
npm run dev        # http://localhost:5173  (contexto seguro para Web Bluetooth)
npm run build      # genera dist/
npm run preview    # sirve el build para probar offline / Lighthouse
```

### Probar BLE desde el móvil en desarrollo
Web Bluetooth exige contexto seguro. Para probar con el teléfono contra tu PC:
usa el build desplegado en Pages, o expón `npm run preview` por un túnel HTTPS
(p. ej. `cloudflared tunnel` / `ngrok`).

## Despliegue en GitHub Pages
1. Crea un repositorio llamado **`rc_pwa`** y sube este código a la rama `main`.
   > Si usas otro nombre de repo, actualiza `base` en `vite.config.ts` y `scope`
   > del manifest para que coincidan con `/<nombre-repo>/`.
2. En **Settings → Pages**, *Source* = **GitHub Actions**.
3. El workflow `.github/workflows/deploy.yml` compila y publica en cada push.
4. URL final: `https://<usuario>.github.io/rc_pwa/`.
5. Ábrela en Chrome (Android), empareja el `TableroRF` una vez e **Instala** la
   app ("Agregar a pantalla de inicio").

## Protocolo (referencia del firmware)
- Service UUID: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- RX (write): `6E400002-…`  ·  TX (notify): `6E400003-…`
- Nombre BLE: `TableroRF`
- Comandos: `BTN_1 BTN_3 BTN_4 BTN_6 BTN_7 BTN_9 BTN_HASH BTN_STAR BTN_LA BTN_LB BTN_LC BTN_LD`
  y config `CFG_R:n`, `INFO`, `HELP`.
