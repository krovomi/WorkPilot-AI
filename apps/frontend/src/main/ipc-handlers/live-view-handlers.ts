/**
 * Les vues vivantes de la matrice d'appareils (#383) : émuler un appareil
 * dans un `<webview>` de la matrice, lire et propager son défilement.
 *
 * Le renderer nomme un `<webview>` par l'id de son contenu ; le main ne le
 * prend que si c'est un invité de la fenêtre qui demande (`resolvePreview`) et
 * s'il montre une page du serveur que l'émulateur a lancé. L'appareil est un
 * id du catalogue ou des appareils personnalisés, le sens un nom de la liste,
 * le défilement deux nombres de 0 à 1 : jamais une taille, un script ou une
 * adresse.
 */
import { type WebContents, ipcMain } from "electron";
import { MAX_LIVE_VIEWS, findOrientation, orientDevice } from "../../shared/constants/device-presets";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { LiveScrollResult, LiveViewError, LiveViewResult } from "../../shared/types/device-library";
import { appEmulatorService } from "../app-emulator-service";
import { findDevice } from "../device-matrix/custom-devices";
import {
	LiveViewError as LiveViewFailure,
	emulateLiveView,
	readLiveScroll,
	readShare,
	setLiveScroll,
	showsOrigin,
} from "../device-matrix/live-views";
import { resolvePreview } from "../preview-point";
import { httpOrigin } from "./device-library-handlers";

const field = (raw: unknown, key: string): unknown =>
	raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;

/** L'invité nommé, s'il est de cette fenêtre et sur le serveur de l'émulateur ; sinon un refus nommé. */
export function liveGuest(sender: WebContents, id: unknown): WebContents | LiveViewError {
	const serverUrl = appEmulatorService.getUrl();
	const origin = serverUrl ? httpOrigin(serverUrl) : null;
	if (!origin) return "not-running";
	const guest = resolvePreview(sender, id);
	if (!guest) return "unknown-view";
	return showsOrigin(guest, origin) ? guest : "elsewhere";
}

export function registerLiveViewHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_EMULATE_LIVE_VIEW,
		async (event, raw: unknown): Promise<LiveViewResult> => {
			const deviceId = field(raw, "deviceId");
			const orientation = findOrientation(field(raw, "orientation"));
			if (typeof deviceId !== "string" || !orientation) return { success: false, error: "invalid-request" };
			const device = await findDevice(deviceId);
			if (!device) return { success: false, error: "unknown-device" };
			const guest = liveGuest(event.sender, field(raw, "webContentsId"));
			if (typeof guest === "string") return { success: false, error: guest };
			try {
				return { success: true, data: await emulateLiveView(guest, orientDevice(device, orientation)) };
			} catch (error: unknown) {
				return { success: false, error: error instanceof LiveViewFailure ? error.code : "emulation-failed" };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_READ_LIVE_SCROLL,
		async (event, raw: unknown): Promise<LiveScrollResult> => {
			const guest = liveGuest(event.sender, field(raw, "webContentsId"));
			if (typeof guest === "string") return { success: false, error: guest };
			const share = await readLiveScroll(guest);
			return share ? { success: true, data: share } : { success: false, error: "unknown-view" };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_SET_LIVE_SCROLL,
		async (event, raw: unknown): Promise<LiveScrollResult> => {
			const ids = field(raw, "webContentsIds");
			const share = readShare(raw);
			if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_LIVE_VIEWS || !share) {
				return { success: false, error: "invalid-request" };
			}
			const guests: WebContents[] = [];
			for (const id of new Set(ids)) {
				const guest = liveGuest(event.sender, id);
				if (typeof guest === "string") return { success: false, error: guest };
				guests.push(guest);
			}
			await setLiveScroll(guests, share);
			return { success: true, data: share };
		},
	);
}
