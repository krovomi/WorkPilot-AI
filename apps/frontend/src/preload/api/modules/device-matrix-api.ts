import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	BreakpointScanRequest,
	BreakpointScanResult,
	CustomDeviceDraft,
	CustomDeviceResult,
	LiveScrollRequest,
	LiveScrollResult,
	LiveViewRequest,
	LiveViewResult,
	PersonaResult,
} from "../../../shared/types/device-library";
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
	/**
	 * Relit la page aux largeurs courantes et autour de ses points de rupture,
	 * sur l'appareil nommé ; le main rend des comptes par largeur.
	 */
	scanEmulatorBreakpoints: (request: BreakpointScanRequest) => Promise<BreakpointScanResult>;
	/** Les appareils personnalisés gardés par le main. */
	listEmulatorCustomDevices: () => Promise<CustomDeviceResult>;
	/** Ajoute un appareil décrit ; le main relit chaque champ dans ses bornes et lui donne son id. */
	saveEmulatorCustomDevice: (draft: CustomDeviceDraft) => Promise<CustomDeviceResult>;
	deleteEmulatorCustomDevice: (id: string) => Promise<CustomDeviceResult>;
	/** Les personas : leur nom, leur hôte, leur nombre de cookies, jamais un cookie. */
	listEmulatorPersonas: () => Promise<PersonaResult>;
	/** Enregistre sous `name` les cookies que l'aperçu envoie au serveur de l'émulateur, chiffrés par le main. */
	saveEmulatorPersona: (name: string) => Promise<PersonaResult>;
	deleteEmulatorPersona: (id: string) => Promise<PersonaResult>;
	/** Pose l'appareil nommé dans un `<webview>` de la matrice ; le main vérifie ce que l'id nomme. */
	emulateEmulatorLiveView: (request: LiveViewRequest) => Promise<LiveViewResult>;
	/** La part défilée d'une vue vivante. */
	readEmulatorLiveScroll: (webContentsId: number) => Promise<LiveScrollResult>;
	/** Défile ces vues vivantes à la même part. */
	setEmulatorLiveScroll: (request: LiveScrollRequest) => Promise<LiveScrollResult>;
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
				persona: request.persona,
			}),
		exportEmulatorDeviceGrid: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID, {
				deviceIds: request.deviceIds,
				format: request.format,
				markers: request.markers,
			}),
		scanEmulatorBreakpoints: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS, {
				deviceId: request.deviceId,
				path: request.path,
				previewSession: request.previewSession,
				persona: request.persona,
			}),
		listEmulatorCustomDevices: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES),
		saveEmulatorCustomDevice: (draft) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, {
				name: draft.name,
				width: draft.width,
				height: draft.height,
				deviceScaleFactor: draft.deviceScaleFactor,
				mobile: draft.mobile,
				touch: draft.touch,
				userAgent: draft.userAgent,
			}),
		deleteEmulatorCustomDevice: (id) => ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE, { id }),
		listEmulatorPersonas: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS),
		saveEmulatorPersona: (name) => ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name }),
		deleteEmulatorPersona: (id) => ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA, { id }),
		emulateEmulatorLiveView: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_EMULATE_LIVE_VIEW, {
				webContentsId: request.webContentsId,
				deviceId: request.deviceId,
				orientation: request.orientation,
			}),
		readEmulatorLiveScroll: (webContentsId) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_READ_LIVE_SCROLL, { webContentsId }),
		setEmulatorLiveScroll: (request) =>
			ipcRenderer.invoke(IPC_CHANNELS.APP_EMULATOR_SET_LIVE_SCROLL, {
				webContentsIds: request.webContentsIds,
				x: request.x,
				y: request.y,
			}),
	};
}
