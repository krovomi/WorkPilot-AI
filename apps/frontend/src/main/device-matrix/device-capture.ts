/**
 * Rendre l'aperçu sur un appareil de la matrice, le photographier et le lire
 * (#383).
 *
 * La page est chargée dans une fenêtre cachée, sans preload, sans Node, en
 * bac à sable, sur une session en mémoire qui refuse toute permission ; elle
 * ne peut ni changer d'origine ni ouvrir de fenêtre ni télécharger. L'appareil
 * est émulé par le protocole des DevTools (fenêtre CSS, densité, tactile,
 * user agent) avant le premier octet, pour que les media queries et le
 * serveur voient le même appareil que la capture.
 *
 * Même architecture que le scan d'accessibilité dynamique
 * (`accessibility/dynamic-scan.ts`) ; le script de lecture tourne dans un
 * monde isolé et sa réponse est remise en forme par `sanitizeReport`.
 */
import { BrowserWindow, session } from "electron";
import type { DeviceCaptureError, DevicePreset, ResponsiveReport } from "../../shared/types/device-matrix";
import { buildProbe, sanitizeReport } from "./responsive-probe";

export const LOAD_TIMEOUT_MS = 30_000;
/** Le temps laissé à une application monopage pour se dessiner après `load`. */
export const SETTLE_MS = 800;
/** Au-delà, l'image ne traverse pas l'IPC (une capture 4K pèse quelques Mo). */
export const MAX_IMAGE_CHARS = 48 * 1024 * 1024;
const PARTITION = "device-matrix";
/** Monde isolé du script de lecture : même DOM, pas les globales de la page. */
const PROBE_WORLD_ID = 1383;

/** Un échec nommé, que le handler rend tel quel au renderer. */
export class DeviceCaptureFailure extends Error {
	constructor(readonly code: DeviceCaptureError) {
		super(code);
	}
}

export interface DeviceShot {
	readonly url: string;
	readonly image: string;
	readonly report: ResponsiveReport | null;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

let sessionGuarded = false;

/** La session de la matrice : en mémoire, sans permission ni téléchargement. Posée une fois. */
function captureSession(): Electron.Session {
	const target = session.fromPartition(PARTITION, { cache: false });
	if (!sessionGuarded) {
		sessionGuarded = true;
		target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		target.setPermissionCheckHandler(() => false);
		target.on("will-download", (event) => event.preventDefault());
	}
	return target;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** L'appareil, posé avant le chargement. */
async function emulate(send: Send, device: DevicePreset): Promise<void> {
	await send("Emulation.setDeviceMetricsOverride", {
		width: device.width,
		height: device.height,
		deviceScaleFactor: device.deviceScaleFactor,
		mobile: device.mobile,
		screenWidth: device.width,
		screenHeight: device.height,
	});
	await send("Emulation.setTouchEmulationEnabled", {
		enabled: device.touch,
		maxTouchPoints: device.touch ? 5 : 0,
	});
	await send("Emulation.setUserAgentOverride", { userAgent: device.userAgent });
}

/**
 * Rend `url` sur `device`. `url` est déjà résolue par le handler sur l'origine
 * du serveur lancé par l'émulateur ; la fenêtre n'en sort pas.
 */
export async function captureDevice(device: DevicePreset, url: string): Promise<DeviceShot> {
	const origin = new URL(url).origin;
	const win = new BrowserWindow({
		show: false,
		width: device.width,
		height: device.height,
		useContentSize: true,
		webPreferences: {
			session: captureSession(),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: false,
			backgroundThrottling: false,
		},
	});
	const wc = win.webContents;
	wc.setWindowOpenHandler(() => ({ action: "deny" }));
	const stayOnOrigin = (event: { preventDefault: () => void }, target: string) => {
		if (!sameOrigin(target, origin)) event.preventDefault();
	};
	wc.on("will-navigate", (event, target) => stayOnOrigin(event, target));
	wc.on("will-redirect", (event, target) => stayOnOrigin(event, target));
	try {
		wc.debugger.attach("1.3");
		const send: Send = (method, params) => wc.debugger.sendCommand(method, params);
		wc.setUserAgent(device.userAgent);
		await emulate(send, device);
		try {
			await withTimeout(wc.loadURL(url), LOAD_TIMEOUT_MS);
		} catch {
			throw new DeviceCaptureFailure("load-failed");
		}
		await wait(SETTLE_MS);
		const raw = await wc
			.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: buildProbe(device) }])
			.catch(() => null);
		const shot = (await send("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: false,
		})) as { data?: unknown } | undefined;
		const data = shot?.data;
		if (typeof data !== "string" || !data || data.length > MAX_IMAGE_CHARS) {
			throw new DeviceCaptureFailure("capture-failed");
		}
		const shown = wc.getURL();
		return {
			url: sameOrigin(shown, origin) ? shown : url,
			image: `data:image/png;base64,${data}`,
			report: sanitizeReport(raw),
		};
	} finally {
		try {
			if (wc.debugger.isAttached()) wc.debugger.detach();
		} catch {
			// parti avec la fenêtre
		}
		win.destroy();
		await captureSession()
			.clearStorageData()
			.catch(() => undefined);
	}
}

function sameOrigin(target: string, origin: string): boolean {
	try {
		return new URL(target).origin === origin;
	} catch {
		return false;
	}
}
