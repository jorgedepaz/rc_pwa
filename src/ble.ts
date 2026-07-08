/*
 * BleController - nucleo BLE de la PWA.
 *
 * Habla con el ESP32 (firmware "Clon RF 433") por su Nordic UART Service:
 *   - Escribe comandos de texto (BTN_1, BTN_HASH, ...) en la caracteristica RX.
 *   - Recibe ACKs por notificacion en la caracteristica TX.
 *
 * Responsabilidades clave:
 *   - Emparejamiento unico (requestDevice) + memoria de dispositivo (getDevices).
 *   - Reconexion automatica ante desconexion o al desbloquear la pantalla.
 *   - Emitir eventos de estado para que la UI se mantenga sincronizada.
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
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private manualDisconnect = false;

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
    return this.status === 'connected';
  }

  private setStatus(status: BleStatus, detail?: string) {
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
        devices.find((d) => d.name === DEVICE_NAME) ?? (devices.length === 1 ? devices[0] : undefined);
      if (match) {
        this.adoptDevice(match);
      }
    } catch {
      // getDevices puede fallar en algunos navegadores; se ignora silenciosamente.
    }
  }

  /**
   * Emparejamiento unico: muestra el selector del sistema. Solo se necesita
   * la primera vez; despues restore() + connect() bastan.
   */
  async pair(): Promise<void> {
    if (!BleController.isSupported()) {
      this.setStatus('unsupported');
      return;
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { name: DEVICE_NAME }],
      optionalServices: [SERVICE_UUID],
    });
    this.adoptDevice(device);
    await this.connect();
  }

  private adoptDevice(device: BluetoothDevice) {
    if (this.device === device) return;
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.emitRemembered();
  }

  // ------------------------------------------------------------------ conectar
  async connect(): Promise<void> {
    if (!this.device) throw new Error('No hay dispositivo recordado. Empareja primero.');
    if (this.status === 'connected' && this.device.gatt?.connected) return;

    this.manualDisconnect = false;
    this.setStatus('connecting');

    const gatt = this.device.gatt;
    if (!gatt) throw new Error('El dispositivo no expone GATT.');

    const server = await gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.rxChar = await service.getCharacteristic(RX_UUID);
    this.txChar = await service.getCharacteristic(TX_UUID);

    await this.txChar.startNotifications();
    this.txChar.addEventListener('characteristicvaluechanged', this.onNotify);

    this.reconnectAttempts = 0;
    this.setStatus('connected');
  }

  /** Desconexion voluntaria (no dispara reconexion automatica). */
  disconnect(): void {
    this.manualDisconnect = true;
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
    // Write-no-response = minima latencia; el firmware soporta WRITE_NR.
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
    if (!this.manualDisconnect) {
      this.scheduleReconnect();
    }
  };

  private onVisibilityChange = () => {
    if (
      document.visibilityState === 'visible' &&
      !this.manualDisconnect &&
      this.device != null &&
      !this.isConnected()
    ) {
      // Reconexion inmediata al volver a primer plano.
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      void this.tryReconnect();
    }
  };

  // --------------------------------------------------------- reconexion (auto)
  private scheduleReconnect() {
    if (this.manualDisconnect || !this.device) return;
    this.clearReconnectTimer();
    // Backoff acotado: 250, 500, 1000, 2000, ... hasta 5 s.
    const delay = Math.min(250 * 2 ** this.reconnectAttempts, 5000);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => void this.tryReconnect(), delay);
  }

  private async tryReconnect() {
    if (this.manualDisconnect || !this.device) return;
    try {
      await this.connect();
    } catch {
      // El ESP32 re-anuncia tras desconectar; reintentamos con backoff.
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
