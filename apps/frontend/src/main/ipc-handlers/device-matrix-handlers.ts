/**
 * La matrice d'appareils de l'émulateur (#383) : une capture par appel.
 *
 * Le renderer nomme un appareil de `DEVICE_PRESETS` et un chemin. Le main
 * prend l'origine du serveur que l'émulateur a lancé (`appEmulatorService`),
 * jamais une URL reçue : le chemin est résolu sur cette origine et refusé
 * s'il en sort (`//hôte`, `/\hôte`, schéma). Une capture à la
 * fois : le renderer enchaîne les appareils, ce qui lui donne la progression
 * et l'arrêt sans canal d'évènements, et ménage la machine (rendu séquentiel).
 */
import { ipcMain } from "electron";
import { findDevicePreset } from "../../shared/constants/device-presets";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { DeviceCaptureError, DeviceCaptureRequest, DeviceCaptureResult } from "../../shared/types/device-matrix";
import { appEmulatorService } from "../app-emulator-service";
import { DeviceCaptureFailure, captureDevice } from "../device-matrix/device-capture";

const MAX_PATH = 2048;

const fail = (error: DeviceCaptureError): DeviceCaptureResult => ({ success: false, error });

/** La requête telle que le main l'accepte, ou `null`. */
export function readCaptureRequest(raw: unknown): DeviceCaptureRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const { deviceId, path } = raw as Record<string, unknown>;
	if (typeof deviceId !== "string" || typeof path !== "string") return null;
	return { deviceId, path };
}

/**
 * L'adresse à rendre : `path` sur l'origine du serveur, ou `null` quand le
 * chemin n'est pas un chemin absolu de cette origine.
 */
export function resolveCaptureUrl(serverUrl: string, path: string): string | null {
	if (!path.startsWith("/") || path.length > MAX_PATH) return null;
	// L'analyseur d'URL efface tabulations et retours à la ligne : on refuse plutôt.
	if (Array.from(path).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return null;
	try {
		const base = new URL(serverUrl);
		if (base.protocol !== "http:" && base.protocol !== "https:") return null;
		const target = new URL(path, base);
		// `//hôte` et `/\hôte` sont des URL d'un autre serveur : l'origine tranche.
		return target.origin === base.origin ? target.toString() : null;
	} catch {
		return null;
	}
}

export function registerDeviceMatrixHandlers(): void {
	let busy = false;
	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, async (_event, raw: unknown): Promise<DeviceCaptureResult> => {
		const request = readCaptureRequest(raw);
		if (!request) return fail("invalid-request");
		const device = findDevicePreset(request.deviceId);
		if (!device) return fail("unknown-device");
		const serverUrl = appEmulatorService.getUrl();
		if (!serverUrl) return fail("not-running");
		const url = resolveCaptureUrl(serverUrl, request.path);
		if (!url) return fail("invalid-path");
		if (busy) return fail("busy");
		busy = true;
		try {
			const shot = await captureDevice(device, url);
			return { success: true, data: { deviceId: device.id, ...shot } };
		} catch (error: unknown) {
			return fail(error instanceof DeviceCaptureFailure ? error.code : "capture-failed");
		} finally {
			busy = false;
		}
	});
}
