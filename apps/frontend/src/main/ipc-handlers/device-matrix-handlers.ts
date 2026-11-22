/**
 * La matrice d'appareils de l'émulateur (#383) : une capture par appel, et
 * l'export de la grille.
 *
 * Le renderer nomme un appareil de `DEVICE_PRESETS`, un chemin, deux
 * profils de bridage (`NETWORK_PROFILES`, `CPU_PROFILES`), jamais des débits
 * ni un facteur, un sens (`DEVICE_ORIENTATIONS`), jamais une taille, et s'il
 * veut la session de l'aperçu — le main lit lui-même ses cookies. Le main prend l'origine du serveur que l'émulateur a lancé
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
 * ni texte, ni chemin. Il choisit le format (`GRID_EXPORT_FORMATS`) et si les
 * éléments fautifs sont encadrés : les cadres viennent du rapport que le main
 * a gardé avec la capture.
 *
 * Un appareil personnalisé (`custom-devices.ts`) se nomme comme un appareil du
 * catalogue ; un persona (`personas.ts`) se nomme par son id, et ses cookies
 * sont déchiffrés ici, jamais envoyés au renderer. La relecture aux points de
 * rupture (`breakpoint-scan.ts`) reçoit les mêmes champs qu'une capture, sans
 * bridage, et partage son verrou.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { DEVICE_PRESETS, findOrientation, orientDevice, orientationOf } from "../../shared/constants/device-presets";
import { findCpuProfile, findNetworkProfile } from "../../shared/constants/emulation-throttling";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { BreakpointScanRequest, BreakpointScanResult } from "../../shared/types/device-library";
import type {
	DeviceCaptureError,
	DeviceCaptureRequest,
	DeviceCaptureResult,
	DeviceGridExportError,
	DeviceGridExportFormat,
	DeviceGridExportResult,
	DevicePreset,
	ResponsiveReport,
} from "../../shared/types/device-matrix";
import { CUSTOM_DEVICE_LIMITS, PERSONA_ID } from "../../shared/utils/custom-device";
import { issueMarkers } from "../../shared/utils/issue-markers";
import { getAppLanguage } from "../app-language";
import { appEmulatorService } from "../app-emulator-service";
import { scanBreakpoints } from "../device-matrix/breakpoint-scan";
import { findDevice, listCustomDevices } from "../device-matrix/custom-devices";
import {
	type CaptureOptions,
	DeviceCaptureFailure,
	type Throttling,
	captureDevice,
} from "../device-matrix/device-capture";
import { type GridTile, composeGrid } from "../device-matrix/grid-export";
import { gridCaption } from "../device-matrix/grid-labels";
import { PersonaFailure, personaCookies } from "../device-matrix/personas";
import { showSaveDialog } from "../electron-utils";
import { registerDeviceLibraryHandlers } from "./device-library-handlers";

const MAX_PATH = 2048;
export const GRID_EXPORT_FORMATS: readonly DeviceGridExportFormat[] = ["png", "pdf"];
const EXPORT_FILTERS: Record<DeviceGridExportFormat, { name: string; extensions: string[] }> = {
	png: { name: "PNG", extensions: ["png"] },
	pdf: { name: "PDF", extensions: ["pdf"] },
};

const fail = (error: DeviceCaptureError): DeviceCaptureResult => ({ success: false, error });
const failExport = (error: DeviceGridExportError): DeviceGridExportResult => ({ success: false, error });
const failScan = (error: DeviceCaptureError): BreakpointScanResult => ({ success: false, error });

/** Le choix de session d'une requête : un booléen et un id de persona ou `null`, l'un ou l'autre. */
function readSessionChoice(fields: Record<string, unknown>): Pick<DeviceCaptureRequest, "previewSession" | "persona"> | null {
	const { previewSession, persona } = fields;
	if (typeof previewSession !== "boolean") return null;
	if (persona !== null && typeof persona !== "string") return null;
	if (previewSession && persona !== null) return null;
	return { previewSession, persona };
}

/** La requête telle que le main l'accepte, ou `null`. */
export function readCaptureRequest(raw: unknown): DeviceCaptureRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const fields = raw as Record<string, unknown>;
	const { deviceId, path: pagePath, network, cpu, orientation } = fields;
	if (typeof deviceId !== "string" || typeof pagePath !== "string") return null;
	if (typeof network !== "string" || typeof cpu !== "string") return null;
	if (typeof orientation !== "string") return null;
	const choice = readSessionChoice(fields);
	if (!choice) return null;
	return { deviceId, path: pagePath, network, cpu, orientation, ...choice };
}

/** La relecture demandée : un appareil, un chemin, un choix de session ; `null` sinon. */
export function readScanRequest(raw: unknown): BreakpointScanRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const fields = raw as Record<string, unknown>;
	if (typeof fields.deviceId !== "string" || typeof fields.path !== "string") return null;
	const choice = readSessionChoice(fields);
	if (!choice) return null;
	return { deviceId: fields.deviceId, path: fields.path, ...choice };
}

/**
 * Ce que la page emprunte : la session de l'aperçu, ou les cookies déchiffrés
 * d'un persona enregistré pour cet hôte. Un échec est nommé.
 */
export async function sessionOptions(
	choice: Pick<DeviceCaptureRequest, "previewSession" | "persona">,
	url: string,
): Promise<CaptureOptions> {
	if (choice.persona === null) return { previewSession: choice.previewSession };
	if (!PERSONA_ID.test(choice.persona)) throw new DeviceCaptureFailure("unknown-persona");
	try {
		return { previewSession: false, persona: await personaCookies(choice.persona, url) };
	} catch (error: unknown) {
		const code = error instanceof PersonaFailure ? error.code : null;
		if (code === "unknown-persona" || code === "persona-locked" || code === "persona-elsewhere") {
			throw new DeviceCaptureFailure(code);
		}
		throw new DeviceCaptureFailure("session-failed");
	}
}

export interface GridExportOrder {
	readonly deviceIds: string[];
	readonly format: DeviceGridExportFormat;
	readonly markers: boolean;
}

/**
 * L'export demandé : des ids du catalogue, sans doublon, dans l'ordre reçu, un
 * format de la liste et un booléen ; `null` pour tout autre chose (un id
 * inconnu compris).
 */
export function readExportRequest(raw: unknown, known: ReadonlySet<string>): GridExportOrder | null {
	if (!raw || typeof raw !== "object") return null;
	const { deviceIds, format, markers } = raw as Record<string, unknown>;
	const most = DEVICE_PRESETS.length + CUSTOM_DEVICE_LIMITS.maxDevices;
	if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > most) return null;
	if (!deviceIds.every((id) => typeof id === "string" && known.has(id))) return null;
	const chosen = GRID_EXPORT_FORMATS.find((known) => known === format);
	if (!chosen || typeof markers !== "boolean") return null;
	return { deviceIds: [...new Set(deviceIds as string[])], format: chosen, markers };
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
	/** L'appareil dans le sens rendu. */
	readonly device: DevicePreset;
	readonly image: string;
	readonly report: ResponsiveReport | null;
}

export function registerDeviceMatrixHandlers(): void {
	// Les appareils personnalisés et les personas que les captures nomment.
	registerDeviceLibraryHandlers();
	let busy = false;
	/** La dernière capture de chaque appareil (au plus une par appareil du catalogue). */
	const kept = new Map<string, KeptCapture>();

	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_CAPTURE_DEVICE, async (_event, raw: unknown): Promise<DeviceCaptureResult> => {
		const request = readCaptureRequest(raw);
		if (!request) return fail("invalid-request");
		const device = await findDevice(request.deviceId);
		if (!device) return fail("unknown-device");
		const network = findNetworkProfile(request.network);
		const cpu = findCpuProfile(request.cpu);
		if (!network || !cpu) return fail("unknown-throttling");
		const orientation = findOrientation(request.orientation);
		if (!orientation) return fail("invalid-request");
		const turned = orientDevice(device, orientation);
		const serverUrl = appEmulatorService.getUrl();
		if (!serverUrl) return fail("not-running");
		const url = resolveCaptureUrl(serverUrl, request.path);
		if (!url) return fail("invalid-path");
		if (busy) return fail("busy");
		busy = true;
		try {
			const options = await sessionOptions(request, url);
			const shot = await captureDevice(turned, url, { network, cpu }, options);
			kept.set(device.id, { device: turned, image: shot.image, report: shot.report, network, cpu });
			return {
				success: true,
				data: {
					deviceId: device.id,
					...shot,
					network: network.id,
					cpu: cpu.id,
					orientation: orientationOf(turned),
					width: turned.width,
					height: turned.height,
					previewSession: request.previewSession,
					persona: request.persona,
				},
			};
		} catch (error: unknown) {
			return fail(error instanceof DeviceCaptureFailure ? error.code : "capture-failed");
		} finally {
			busy = false;
		}
	});

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_SCAN_BREAKPOINTS,
		async (_event, raw: unknown): Promise<BreakpointScanResult> => {
			const request = readScanRequest(raw);
			if (!request) return failScan("invalid-request");
			const device = await findDevice(request.deviceId);
			if (!device) return failScan("unknown-device");
			const serverUrl = appEmulatorService.getUrl();
			if (!serverUrl) return failScan("not-running");
			const url = resolveCaptureUrl(serverUrl, request.path);
			if (!url) return failScan("invalid-path");
			if (busy) return failScan("busy");
			busy = true;
			try {
				const scan = await scanBreakpoints(device, url, await sessionOptions(request, url));
				return { success: true, data: { deviceId: device.id, ...scan } };
			} catch (error: unknown) {
				return failScan(error instanceof DeviceCaptureFailure ? error.code : "capture-failed");
			} finally {
				busy = false;
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_EXPORT_DEVICE_GRID,
		async (_event, raw: unknown): Promise<DeviceGridExportResult> => {
			const known = new Set([...DEVICE_PRESETS, ...(await listCustomDevices())].map((device) => device.id));
			const order = readExportRequest(raw, known);
			if (!order) return failExport("invalid-request");
			const captures = order.deviceIds.flatMap((id) => kept.get(id) ?? []);
			if (captures.length === 0) return failExport("nothing-to-export");
			if (busy) return failExport("busy");
			busy = true;
			try {
				const { canceled, filePath } = await showSaveDialog({
					defaultPath: `device-matrix.${order.format}`,
					filters: [EXPORT_FILTERS[order.format]],
				});
				if (canceled || !filePath) return { success: true, data: { saved: false } };
				const language = getAppLanguage();
				const tiles: GridTile[] = captures.map((capture) => ({
					...gridCaption(capture.device, capture.network, capture.cpu, language),
					image: capture.image,
					aspect: capture.device.height / capture.device.width,
					markers: order.markers
						? issueMarkers(capture.report, capture.device.width, capture.device.height)
						: [],
				}));
				let file: Buffer;
				try {
					file = await composeGrid(tiles, order.format);
				} catch {
					return failExport("export-failed");
				}
				try {
					await writeFile(filePath, file);
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
