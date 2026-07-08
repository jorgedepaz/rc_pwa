/*
 * ui.ts - Construye y controla la interfaz: teclado replica del control fisico,
 * barra de estado de conexion y banner de aviso para iOS.
 */

import { BleController, type BleStatus } from './ble';

// Mapa de teclas del control fisico -> comando que entiende el firmware.
// (etiqueta visible, comando, clase de color opcional)
interface Key {
  label: string;
  cmd: string;
  variant?: 'num' | 'sym' | 'letter';
}

// Disposicion en rejilla de 3 columnas (se llena fila por fila):
//   col1: 1 4 7 *   |   col2: 3 6 9 #   |   col3: A B C D
const KEYS: Key[] = [
  { label: '1', cmd: 'BTN_1', variant: 'num' },
  { label: '3', cmd: 'BTN_3', variant: 'num' },
  { label: 'A', cmd: 'BTN_LA', variant: 'letter' },
  { label: '4', cmd: 'BTN_4', variant: 'num' },
  { label: '6', cmd: 'BTN_6', variant: 'num' },
  { label: 'B', cmd: 'BTN_LB', variant: 'letter' },
  { label: '7', cmd: 'BTN_7', variant: 'num' },
  { label: '9', cmd: 'BTN_9', variant: 'num' },
  { label: 'C', cmd: 'BTN_LC', variant: 'letter' },
  { label: '*', cmd: 'BTN_STAR', variant: 'sym' },
  { label: '#', cmd: 'BTN_HASH', variant: 'sym' },
  { label: 'D', cmd: 'BTN_LD', variant: 'letter' },
];

const STATUS_TEXT: Record<BleStatus, string> = {
  unsupported: 'Bluetooth no disponible',
  idle: 'Sin conectar',
  connecting: 'Conectando…',
  connected: 'Conectado',
  disconnected: 'Desconectado',
};

export function mountUI(root: HTMLElement, ble: BleController): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="statusbar">
        <div class="status">
          <span class="dot" id="status-dot"></span>
          <span id="status-text">Sin conectar</span>
        </div>
        <div class="actions">
          <button id="btn-connect" class="btn-secondary" hidden>Conectar</button>
          <button id="btn-pair" class="btn-primary">Emparejar</button>
          <button id="btn-disconnect" class="btn-ghost" hidden>Desconectar</button>
        </div>
      </header>

      <main class="keypad" id="keypad"></main>

      <footer class="footer">
        <span id="ack" class="ack">—</span>
      </footer>
    </div>
  `;

  const statusDot = root.querySelector<HTMLSpanElement>('#status-dot')!;
  const statusText = root.querySelector<HTMLSpanElement>('#status-text')!;
  const btnPair = root.querySelector<HTMLButtonElement>('#btn-pair')!;
  const btnConnect = root.querySelector<HTMLButtonElement>('#btn-connect')!;
  const btnDisconnect = root.querySelector<HTMLButtonElement>('#btn-disconnect')!;
  const keypad = root.querySelector<HTMLElement>('#keypad')!;
  const ackEl = root.querySelector<HTMLSpanElement>('#ack')!;

  // ---- Teclado ----
  const keyButtons: HTMLButtonElement[] = KEYS.map((key) => {
    const b = document.createElement('button');
    b.className = `key key-${key.variant ?? 'num'}`;
    b.textContent = key.label;
    b.disabled = true;
    b.addEventListener('click', () => {
      void handlePress(key, b);
    });
    keypad.appendChild(b);
    return b;
  });

  async function handlePress(key: Key, btn: HTMLButtonElement) {
    if (!ble.isConnected()) return;
    navigator.vibrate?.(20);
    btn.classList.add('pressed');
    window.setTimeout(() => btn.classList.remove('pressed'), 120);
    try {
      await ble.send(key.cmd);
    } catch (err) {
      showAck(`Error: ${(err as Error).message}`);
    }
  }

  function showAck(msg: string) {
    ackEl.textContent = msg;
  }

  // ---- Reflejar estado de conexion en la UI ----
  function render(status: BleStatus) {
    statusText.textContent = STATUS_TEXT[status];
    statusDot.dataset.state = status;

    const connected = status === 'connected';
    const hasRemembered = ble.hasRememberedDevice();

    for (const b of keyButtons) b.disabled = !connected;

    btnPair.hidden = connected || hasRemembered;
    btnConnect.hidden = connected || !hasRemembered;
    btnConnect.disabled = status === 'connecting';
    btnDisconnect.hidden = !connected;
  }

  // ---- Handlers de botones ----
  btnPair.addEventListener('click', async () => {
    try {
      await ble.pair();
    } catch (err) {
      showAck(`No se pudo emparejar: ${(err as Error).message}`);
    }
  });

  btnConnect.addEventListener('click', async () => {
    try {
      await ble.connect();
    } catch (err) {
      showAck(`No se pudo conectar: ${(err as Error).message}`);
    }
  });

  btnDisconnect.addEventListener('click', () => ble.disconnect());

  // ---- Suscripciones a eventos del controlador BLE ----
  ble.on('status', (status, detail) => {
    render(status);
    if (detail) showAck(detail);
  });
  ble.on('ack', (msg) => showAck(msg));
  ble.on('remembered', () => render(ble.getStatus()));

  render(ble.getStatus());
}
