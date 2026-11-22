/**
 * Rendre l'aperçu sur un appareil de la matrice, le photographier et le lire
 * (#383).
 *
 * La page est chargée dans une fenêtre cachée, sans preload, sans Node, en
 * bac à sable, sur une session en mémoire qui refuse toute permission ; elle
 * ne peut ni changer d'origine ni ouvrir de fenêtre ni télécharger. L'appareil
 * est émulé par le protocole des DevTools (fenêtre CSS, densité, tactile,
 * user agent) avant le premier octet, pour que les media queries et le
 * serveur voient le même appareil que la capture. Le bridage réseau et
 * processeur, quand un profil en demande, est posé de même, avant le
 * chargement, et le temps de chargement mesuré sous ce bridage. Un appareil
 * tourné (paysage d'un téléphone, écran pivoté) arrive avec sa fenêtre déjà
 * échangée ; l'écran émulé annonce alors ce sens (`screen.orientation`).
 * Sur demande, les cookies que l'aperçu envoie à ce serveur sont copiés dans
 * la session de la capture (`preview-session.ts`).
 *
 * Même architecture que le scan d'accessibilité dynamique
 * (`accessibility/dynamic-scan.ts`) ; le script de lecture tourne dans un
 * monde isolé et sa réponse est remise en forme par `sanitizeReport`.
 */
import { BrowserWindow, session } from "electron";
import { isRotated, orientationOf } from "../../shared/constants/device-presets";
import {
	CPU_PROFILES,
	NETWORK_PROFILES,
	loadTimeoutFor,
} from "../../shared/constants/emulation-throttling";
import type {
	CpuProfile,
	DeviceCaptureError,
	DevicePreset,
	NetworkProfile,
	ResponsiveReport,
} from "../../shared/types/device-matrix";
import { type CookieCopy, copyCookies, sharePreviewCookies } from "./preview-session";
import { buildProbe, sanitizeReport } from "./responsive-probe";

/** Le temps laissé à une application monopage pour se dessiner après `load`, multiplié par le ralentissement du processeur. */
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
	/** Durée du chargement jusqu'à `load`, en millisecondes. */
	readonly loadMs: number;
}

/** Les profils déjà relus par le handler dans leurs listes fermées. */
export interface Throttling {
	readonly network: NetworkProfile;
	readonly cpu: CpuProfile;
}

/** Ce que la capture emprunte à l'aperçu, ou à un persona. */
export interface CaptureOptions {
	/** Copier les cookies de l'aperçu pour l'origine rendue. */
	readonly previewSession: boolean;
	/** Les cookies déchiffrés d'un persona, posés avant le chargement (`personas.ts`). */
	readonly persona?: readonly CookieCopy[];
}

/** La page chargée sur l'appareil, prête à être lue ou photographiée. */
export interface DevicePage {
	readonly wc: Electron.WebContents;
	readonly send: Send;
	/** Durée du chargement jusqu'à `load`, en millisecondes. */
	readonly loadMs: number;
	readonly origin: string;
}

/** Sans bridage : ni le réseau ni le processeur ne sont touchés. */
export const NO_THROTTLING: Throttling = { network: NETWORK_PROFILES[0], cpu: CPU_PROFILES[0] };

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const guardedPartitions = new Set<string>();

/** Une session en mémoire, sans permission ni téléchargement. Les gardes sont posées une fois. */
export function guardedSession(partition: string): Electron.Session {
	const target = session.fromPartition(partition, { cache: false });
	if (!guardedPartitions.has(partition)) {
		guardedPartitions.add(partition);
		target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		target.setPermissionCheckHandler(() => false);
		target.on("will-download", (event) => event.preventDefault());
	}
	return target;
}

/** La session de la matrice. */
const captureSession = () => guardedSession(PARTITION);

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** L'appareil, posé avant le chargement (et à chaque largeur d'une relecture). */
export async function emulate(send: Send, device: DevicePreset): Promise<void> {
	await send("Emulation.setDeviceMetricsOverride", {
		width: device.width,
		height: device.height,
		deviceScaleFactor: device.deviceScaleFactor,
		mobile: device.mobile,
		screenWidth: device.width,
		screenHeight: device.height,
		screenOrientation: {
			type: orientationOf(device) === "landscape" ? "landscapePrimary" : "portraitPrimary",
			// Tourné depuis son sens naturel : un quart de tour.
			angle: isRotated(device) ? 90 : 0,
		},
	});
	await send("Emulation.setTouchEmulationEnabled", {
		enabled: device.touch,
		maxTouchPoints: device.touch ? 5 : 0,
	});
	await send("Emulation.setUserAgentOverride", { userAgent: device.userAgent });
}

/**
 * Le bridage, posé avant le chargement. Sans profil, rien n'est envoyé. Un
 * refus du protocole est un échec nommé : une capture « bridée » qui ne l'est
 * pas tromperait plus qu'elle n'aiderait.
 */
async function throttle(send: Send, { network, cpu }: Throttling): Promise<void> {
	try {
		if (network.conditions) {
			await send("Network.enable");
			await send("Network.emulateNetworkConditions", {
				offline: false,
				latency: network.conditions.latencyMs,
				downloadThroughput: network.conditions.downloadBytesPerSecond,
				uploadThroughput: network.conditions.uploadBytesPerSecond,
			});
		}
		if (cpu.rate > 1) await send("Emulation.setCPUThrottlingRate", { rate: cpu.rate });
	} catch {
		throw new DeviceCaptureFailure("throttling-failed");
	}
}

/**
 * Charge `url` sur `device` dans la fenêtre cachée, puis passe la page à
 * `work`. `url` est déjà résolue par le handler sur l'origine du serveur lancé
 * par l'émulateur ; la fenêtre n'en sort pas. Fenêtre détruite et session
 * vidée quoi qu'il arrive.
 */
export async function withDevicePage<T>(
	device: DevicePreset,
	url: string,
	throttling: Throttling,
	options: CaptureOptions,
	work: (page: DevicePage) => Promise<T>,
): Promise<T> {
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
		await throttle(send, throttling);
		if (options.previewSession || options.persona) {
			try {
				if (options.persona) await copyCookies(captureSession(), origin, options.persona);
				else await sharePreviewCookies(captureSession(), origin);
			} catch {
				throw new DeviceCaptureFailure("session-failed");
			}
		}
		const started = Date.now();
		try {
			await withTimeout(wc.loadURL(url), loadTimeoutFor(throttling.network, throttling.cpu));
		} catch {
			throw new DeviceCaptureFailure("load-failed");
		}
		const loadMs = Date.now() - started;
		await wait(SETTLE_MS * throttling.cpu.rate);
		return await work({ wc, send, loadMs, origin });
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

/** Le script de lecture dans son monde isolé ; `null` quand la page ne répond pas. */
export function runProbe(wc: Electron.WebContents, code: string): Promise<unknown> {
	return wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code }]).catch(() => null);
}

/** Rend `url` sur `device`, le photographie et le lit. */
export function captureDevice(
	device: DevicePreset,
	url: string,
	throttling: Throttling = NO_THROTTLING,
	options: CaptureOptions = { previewSession: false },
): Promise<DeviceShot> {
	return withDevicePage(device, url, throttling, options, async ({ wc, send, loadMs, origin }) => {
		const raw = await runProbe(wc, buildProbe(device));
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
			loadMs,
		};
	});
}

export function sameOrigin(target: string, origin: string): boolean {
	try {
		return new URL(target).origin === origin;
	} catch {
		return false;
	}
}
