import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { BleController } from './ble';
import { mountUI } from './ui';

// Registro del service worker (auto-update). Habilita la app 100% offline.
registerSW({ immediate: true });

const root = document.getElementById('app')!;
const ble = new BleController();

mountUI(root, ble);

// Recupera un dispositivo ya autorizado (si lo hay) para permitir la
// reconexion de un solo toque sin volver a mostrar el selector.
void ble.restore().then(() => {
  // Si ya habia un tablero recordado, intentar reconectar de inmediato.
  if (ble.hasRememberedDevice() && !ble.isConnected()) {
    void ble.connect().catch(() => {
      /* el usuario puede tocar "Conectar" manualmente */
    });
  }
});
