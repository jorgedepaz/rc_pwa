/*
 * BleController - nucleo BLE de la PWA.
 *
 * Habla con el ESP32 (firmware "Clon RF 433") por su Nordic UART Service:
 *   - Escribe comandos de texto (BTN_1, BTN_HASH, ...) en la caracteristica RX.
 *   - Recibe ACKs por notificacion en la caracteristica TX.
 *
 * Reconexion robusta:
 *   - `wantConnected` = estado deseado (queremos estar conectados).
 *   - `connecting`    = candado "single-flight": nunca hay dos gatt.connect()
 *                       simultaneos (esa era la causa del bucle de reconexion).
 *   - Un solo temporizador de backoff. gattserverdisconnected y visibilitychange
 *     solo *piden* reconectar; ensureConnected() decide y serializa.
 */

// ---- UUIDs Nordic UART Service (NUS) -- deben coincidir con el firmware ----
const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app -> ESP32 (write)
const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // ESP32 -> app (notify)
const DEVICE_NAME = 'TableroRF';

export type BleStatus = 'unsupported' | 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface BleEvents {
  status: (status: BleStatus, detail?: string) => void;
  ack: (message: string) => void;
  /** Se emite cuando hay (o deja de haber) un dispositivo recordado. */
  remembered: (hasDevice: boolean) => void;
}

export class BleController {
  private device: BluetoothDevice | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;

  private status: BleStatus = 'idle';

  // --- control de reconexion ---
  private wantConnected = false; // estado deseado por el usuario
  private connecting = false; // candado single-flight (evita conexiones solapadas)
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  private listeners: { [K in keyof BleEvents]: Set<BleEvents[K]> } = {
    status: new Set(),
    ack: new Set(),
    remembered: new Set(),
  };

  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor() {
    if (!BleController.isSupported()) {
      this.setStatus('unsupported');
    }
    // Reconexion al volver la app a primer plano (cubre bloqueo/desbloqueo).
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  // ------------------------------------------------------------------ eventos
  on<K extends keyof BleEvents>(event: K, cb: BleEvents[K]): void {
    this.listeners[event].add(cb);
  }

  private emitStatus(detail?: string) {
    for (const cb of this.listeners.status) cb(this.status, detail);
  }
  private emitAck(msg: string) {
    for (const cb of this.listeners.ack) cb(msg);
  }
  private emitRemembered() {
    const has = this.device != null;
    for (const cb of this.listeners.remembered) cb(has);
  }

  getStatus(): BleStatus {
    return this.status;
  }
  hasRememberedDevice(): boolean {
    return this.device != null;
  }
  isConnected(): boolean {
    return this.status === 'connected' && this.device?.gatt?.connected === true;
  }

  private setStatus(status: BleStatus, detail?: string) {
    if (this.status === status && !detail) return;
    this.status = status;
    this.emitStatus(detail);
  }

  // ------------------------------------------------------- descubrir / recordar
  /**
   * Al arrancar: recupera dispositivos ya autorizados (sin mostrar selector)
   * para habilitar la reconexion de un solo toque.
   */
  async restore(): Promise<void> {
    if (!BleController.isSupported()) return;
    const bt = navigator.bluetooth as Bluetooth & {
      getDevices?: () => Promise<BluetoothDevice[]>;
    };
    if (typeof bt.getDevices !== 'function') return; // navegador sin persistencia
    try {
      const devices = await bt.getDevices();
      const match =
        devices.find((d) => d.name === DEVICE_NAME) ??
        (devices.length === 1 ? devices[0] : undefined);
      if (match) this.adoptDevice(match);
    } catch {
      // getDevices puede fallar en algunos navegadores; se ignora.
    }
  }

  /**
   * Emparejamiento unico: muestra el selector del sistema. Solo la primera vez;
   * despues restore() + connect() bastan.
   */
  async pair(): Promise<void> {
    if (!BleController.isSupported()) {
      this.setStatus('unsupported');
      return;
    }
    // Estado limpio: descarta cualquier referencia previa (p.ej. una obtenida de
    // getDevices() que Bluefy no autoriza) antes de pedir una nueva del selector.
    this.forgetDevice();
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { name: DEVICE_NAME }],
      optionalServices: [SERVICE_UUID],
    });
    this.adoptDevice(device);
    this.wantConnected = true;
    this.reconnectAttempts = 0;
    // Bluefy/iOS a veces rechaza la conexion inmediata tras elegir en el
    // selector (el ESP32 acaba de dejar de anunciarse): reintentamos 1-2 veces.
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.ensureConnected();
        return;
      } catch (err) {
        lastErr = err;
        await BleController.delay(400);
      }
    }
    throw lastErr;
  }

  private adoptDevice(device: BluetoothDevice) {
    if (this.device === device) return;
    this.detachDevice();
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.emitRemembered();
  }

  /** Quita listeners del dispositivo actual sin cambiar el estado deseado. */
  private detachDevice() {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }
  }

  /** Olvida por completo el dispositivo recordado (obliga a re-emparejar). */
  private forgetDevice() {
    this.detachDevice();
    this.device = null;
    this.rxChar = null;
    this.txChar = null;
    this.wantConnected = false;
    this.clearReconnectTimer();
    this.emitRemembered();
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * True si el error indica que el navegador no autoriza este dispositivo para
   * el origen (tipico de Bluefy al reusar un device de getDevices). En ese caso
   * no tiene sentido reintentar: hay que volver a emparejar desde el selector.
   */
  private static isPermissionError(err: unknown): boolean {
    const e = err as { name?: string; message?: string };
    const name = e?.name ?? '';
    const msg = e?.message ?? '';
    return (
      name === 'SecurityError' ||
      name === 'NotAllowedError' ||
      /was not offered to this origin/i.test(msg)
    );
  }

  // ------------------------------------------------------------------ conectar
  /** Solicita conectar (y mantenerse conectado). */
  async connect(): Promise<void> {
    if (!this.device) throw new Error('No hay dispositivo recordado. Empareja primero.');
    this.wantConnected = true;
    this.reconnectAttempts = 0;
    try {
      await this.ensureConnected();
    } catch (err) {
      if (BleController.isPermissionError(err)) {
        // Dispositivo recordado ya no autorizado por el navegador: olvidarlo
        // para que la UI muestre "Emparejar" y el usuario pase por el selector.
        this.forgetDevice();
      }
      throw err;
    }
  }

  /**
   * Nucleo de conexion serializada. El candado `connecting` garantiza que
   * jamas haya dos intentos de conexion en paralelo (la causa del bucle).
   */
  private async ensureConnected(): Promise<void> {
    if (this.connecting) return; // ya hay un intento en curso
    if (this.isConnected()) return;
    if (!this.device?.gatt) return;

    this.connecting = true;
    this.clearReconnectTimer();
    this.setStatus('connecting');
    try {
      const gatt = this.device.gatt;
      if (!gatt.connected) await gatt.connect();

      const service = await gatt.getPrimaryService(SERVICE_UUID);
      this.rxChar = await service.getCharacteristic(RX_UUID);
      this.txChar = await service.getCharacteristic(TX_UUID);

      await this.txChar.startNotifications();
      this.txChar.removeEventListener('characteristicvaluechanged', this.onNotify);
      this.txChar.addEventListener('characteristicvaluechanged', this.onNotify);

      this.reconnectAttempts = 0;
      this.setStatus('connected');
    } catch (err) {
      this.rxChar = null;
      this.txChar = null;
      // Deja el GATT en estado limpio para el proximo intento.
      if (this.device?.gatt?.connected) {
        try {
          this.device.gatt.disconnect();
        } catch {
          /* ignore */
        }
      }
      this.setStatus('disconnected');
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  /** Desconexion voluntaria (detiene la reconexion automatica). */
  disconnect(): void {
    this.wantConnected = false;
    this.clearReconnectTimer();
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    } else {
      this.setStatus('disconnected');
    }
  }

  // ------------------------------------------------------------------- enviar
  /** Envia un comando de texto (p.ej. "BTN_1") a la caracteristica RX. */
  async send(cmd: string): Promise<void> {
    if (!this.rxChar || !this.isConnected()) {
      throw new Error('Sin conexion con el tablero.');
    }
    const data = this.encoder.encode(cmd);
    if (this.rxChar.properties.writeWithoutResponse) {
      await this.rxChar.writeValueWithoutResponse(data);
    } else {
      await this.rxChar.writeValue(data);
    }
  }

  // ------------------------------------------------------------- callbacks BLE
  private onNotify = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target.value) return;
    const msg = this.decoder.decode(target.value).trim();
    if (msg) this.emitAck(msg);
  };

  private onDisconnected = () => {
    this.rxChar = null;
    this.txChar = null;
    this.setStatus('disconnected');
    if (this.wantConnected) this.scheduleReconnect();
  };

  private onVisibilityChange = () => {
    if (
      document.visibilityState === 'visible' &&
      this.wantConnected &&
      !this.connecting &&
      !this.isConnected()
    ) {
      // Reintento inmediato al volver a primer plano (reinicia el backoff).
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      void this.tryReconnect();
    }
  };

  // --------------------------------------------------------- reconexion (auto)
  private scheduleReconnect() {
    if (!this.wantConnected || !this.device) return;
    if (this.connecting || this.reconnectTimer != null) return; // ya hay algo en marcha
    // Backoff acotado: 500ms, 1s, 2s, 4s, hasta 8s. El ESP32 necesita ~500ms
    // para re-anunciar tras una desconexion (ver su loop()).
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delay);
  }

  private async tryReconnect() {
    if (!this.wantConnected) return;
    try {
      await this.ensureConnected();
    } catch (err) {
      if (BleController.isPermissionError(err)) {
        // El navegador ya no autoriza este dispositivo: detener el bucle y
        // pedir re-emparejar (no se puede abrir el selector sin gesto del usuario).
        this.forgetDevice();
        this.setStatus('disconnected', 'Vuelve a emparejar el tablero.');
        return;
      }
      this.scheduleReconnect();
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
