/**
 * La matrice d'appareils de l'émulateur (#383) : une capture par appel, et
 * l'export de la grille.
 *
 * Le renderer nomme un appareil de `DEVICE_PRESETS`, un chemin et deux
 * profils de bridage (`NETWORK_PROFILES`, `CPU_PROFILES`), jamais des débits
 * ni un facteur. Le main prend l'origine du serveur que l'émulateur a lancé
 * (`appEmulatorService`), jamais une URL reçue : le chemin est résolu sur
 * cette origine et refusé s'il en sort (`//hôte`, `/\hôte`, schéma). Une
 * capture à la fois : le renderer enchaîne les appareils, ce qui lui donne la
 * progression et l'arrêt sans canal d'évènements, et ménage la machine
 * (rendu séquentiel).
 *
 * L'export ne reçoit que des identifiants d'appareils : les images sont les
 * dernières captures du main (gardées en mémoire, une par appareil), les
 * légendes sont écrites par le main, et le fichier est écrit là où la
 * personne l'a choisi dans la boîte native — le renderer ne fournit ni pixel,
 * ni texte, ni chemin.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { DEVICE_PRESETS, findDevicePreset } from "../../shared/constants/device-presets";
import { findCpuProfile, findNetworkProfile } from "../../shared/constants/emulation-throttling";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	DeviceCaptureError,
	DeviceCaptureRequest,
	DeviceCaptureResult,
	DeviceGridExportError,
	DeviceGridExportResult,
	DevicePreset,
} from "../../shared/types/device-matrix";
import { getAppLanguage } from "../app-language";
import { appEmulatorService } from "../app-emulator-service";
import { DeviceCaptureFailure, type Throttling, captureDevice } from "../device-matrix/device-capture";
import { type GridTile, composeGrid } from "../device-matrix/grid-export";
import { gridCaption } from "../device-matrix/grid-labels";
import { showSaveDialog } from "../electron-utils";

const MAX_PATH = 2048;
const EXPORT_FILE_NAME = "device-matrix.png";

const fail = (error: DeviceCaptureError): DeviceCaptureResult => ({ success: false, error });
const failExport = (error: DeviceGridExportError): DeviceGridExportResult => ({ success: false, error });

/** La requête telle que le main l'accepte, ou `null`. */
export function readCaptureRequest(raw: unknown): DeviceCaptureRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const { deviceId, path: pagePath, network, cpu } = raw as Record<string, unknown>;
	if (typeof deviceId !== "string" || typeof pagePath !== "string") return null;
	if (typeof network !== "string" || typeof cpu !== "string") return null;
	return { deviceId, path: pagePath, network, cpu };
}

/**
 * Les appareils à exporter : des ids du catalogue, sans doublon, dans l'ordre
 * reçu ; `null` pour tout autre chose (un id inconnu compris).
 */
export function readExportRequest(raw: unknown): string[] | null {
	if (!raw || typeof raw !== "object") return null;
	const { deviceIds } = raw as Record<string, unknown>;
	if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > DEVICE_PRESETS.length) return null;
	if (!deviceIds.every((id) => findDevicePreset(id) !== undefined)) return null;
	return [...new Set(deviceIds as string[])];
}

/**
 * L'adresse à rendre : `path` sur l'origine du serveur, ou `null` quand le
 * chemin n'est pas un chemin absolu de cette origine.
 */
export function resolveCaptureUrl(serverUrl: string, pagePath: string): string | null {
	if (!pagePath.startsWith("/") || pagePath.length > MAX_PATH) return null;
	// L'analyseur d'URL efface tabulations et retours à la ligne : on refuse plutôt.
	if (Array.from(pagePath).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return null;
	try {
		const base = new URL(serverUrl);
		if (base.protocol !== "http:" && base.protocol !== "https:") return null;
		const target = new URL(pagePath, base);
		// `//hôte` et `/\hôte` sont des URL d'un autre serveur : l'origine tranche.
		return target.origin === base.origin ? target.toString() : null;
	} catch {
		return null;
	}
}

/** Une capture gardée pour l'export : l'image du main et ce qui l'a produite. */
interface KeptCapture extends Throttling {
	readonly device: DevicePreset;
	readonly image: string;
}

export function registerDeviceMatrixHandlers(): void {
	let busy = false;
	/** La dernière capture de chaque appareil (au plus une par appareil du catalogue). */
	const kept = new Map<string, KeptCapture>();

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, async (_event, raw: unknown): Promise<DeviceCaptureResult> => {
		const request = readCaptureRequest(raw);
		if (!request) return fail("invalid-request");
		const device = findDevicePreset(request.deviceId);
		if (!device) return fail("unknown-device");
		const network = findNetworkProfile(request.network);
		const cpu = findCpuProfile(request.cpu);
		if (!network || !cpu) return fail("unknown-throttling");
		const serverUrl = appEmulatorService.getUrl();
		if (!serverUrl) return fail("not-running");
		const url = resolveCaptureUrl(serverUrl, request.path);
		if (!url) return fail("invalid-path");
		if (busy) return fail("busy");
		busy = true;
		try {
			const shot = await captureDevice(device, url, { network, cpu });
			kept.set(device.id, { device, image: shot.image, network, cpu });
			return { success: true, data: { deviceId: device.id, ...shot, network: network.id, cpu: cpu.id } };
		} catch (error: unknown) {
			return fail(error instanceof DeviceCaptureFailure ? error.code : "capture-failed");
		} finally {
			busy = false;
		}
	});

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID,
		async (_event, raw: unknown): Promise<DeviceGridExportResult> => {
			const deviceIds = readExportRequest(raw);
			if (!deviceIds) return failExport("invalid-request");
			const captures = deviceIds.flatMap((id) => kept.get(id) ?? []);
			if (captures.length === 0) return failExport("nothing-to-export");
			if (busy) return failExport("busy");
			busy = true;
			try {
				const { canceled, filePath } = await showSaveDialog({
					defaultPath: EXPORT_FILE_NAME,
					filters: [{ name: "PNG", extensions: ["png"] }],
				});
				if (canceled || !filePath) return { success: true, data: { saved: false } };
				const language = getAppLanguage();
				const tiles: GridTile[] = captures.map((capture) => ({
					...gridCaption(capture.device, capture.network, capture.cpu, language),
					image: capture.image,
					aspect: capture.device.height / capture.device.width,
				}));
				let png: Buffer;
				try {
					png = await composeGrid(tiles);
				} catch {
					return failExport("export-failed");
				}
				try {
					await writeFile(filePath, png);
				} catch {
					return failExport("write-failed");
				}
				return { success: true, data: { saved: true, fileName: path.basename(filePath) } };
			} finally {
				busy = false;
			}
		},
	);
}
