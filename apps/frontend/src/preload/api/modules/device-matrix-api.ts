import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	DeviceCaptureRequest,
	DeviceCaptureResult,
	DeviceGridExportRequest,
	DeviceGridExportResult,
} from "../../../shared/types/device-matrix";

/** La matrice d'appareils de l'émulateur (#383). */
export interface DeviceMatrixAPI {
	/**
	 * Rend le chemin `path` du serveur lancé par l'émulateur sur l'appareil
	 * `deviceId`, dans le sens nommé, sous les profils de bridage nommés, avec
	 * ou sans la session de l'aperçu, le photographie et le lit. Le main
	 * choisit l'origine, applique les profils et lit lui-même les cookies.
	 */
	captureEmulatorDevice: (request: DeviceCaptureRequest) => Promise<DeviceCaptureResult>;
	/**
	 * Exporte en PNG ou en PDF la grille des dernières captures du main pour
	 * ces appareils, éléments fautifs encadrés ou non ; le main demande où
	 * l'écrire dans une boîte native.
	 */
	exportEmulatorDeviceGrid: (request: DeviceGridExportRequest) => Promise<DeviceGridExportResult>;
}

export function createDeviceMatrixAPI(): DeviceMatrixAPI {
	return {
		captureEmulatorDevice: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, {
				deviceId: request.deviceId,
				path: request.path,
				network: request.network,
				cpu: request.cpu,
				orientation: request.orientation,
				previewSession: request.previewSession,
			}),
		exportEmulatorDeviceGrid: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID, {
				deviceIds: request.deviceIds,
				format: request.format,
				markers: request.markers,
			}),
	};
}
