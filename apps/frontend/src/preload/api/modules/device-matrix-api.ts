import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { DeviceCaptureRequest, DeviceCaptureResult } from "../../../shared/types/device-matrix";

/** La matrice d'appareils de l'émulateur (#383). */
export interface DeviceMatrixAPI {
	/**
	 * Rend le chemin `path` du serveur lancé par l'émulateur sur l'appareil
	 * `deviceId`, le photographie et le lit. Le main choisit l'origine.
	 */
	captureEmulatorDevice: (request: DeviceCaptureRequest) => Promise<DeviceCaptureResult>;
}

export function createDeviceMatrixAPI(): DeviceMatrixAPI {
	return {
		captureEmulatorDevice: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, {
				deviceId: request.deviceId,
				path: request.path,
			}),
	};
}
