/**
 * Les appareils de la matrice de l'émulateur (#383).
 *
 * Partagé entre le renderer, qui les propose, et le main, qui n'émule que
 * ceux-là : un appareil est désigné par son `id`, jamais décrit par le
 * renderer. Fenêtres et densités reprennent les profils d'appareils des
 * DevTools de Chromium ; le user agent est celui du navigateur livré avec
 * l'appareil, pour que le serveur réponde ce qu'il répondrait à un vrai
 * téléphone.
 */
import type { DevicePreset } from "../types/device-matrix";

const IOS_PHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
	"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const androidUa = (model: string, version: number) =>
	`Mozilla/5.0 (Linux; Android ${version}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36`;
const DESKTOP_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TV_UA =
	"Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.31 TV Safari/537.36";

export const DEVICE_PRESETS: readonly DevicePreset[] = [
	{ id: "iphone-15", category: "phone", width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IOS_PHONE_UA },
	{ id: "iphone-15-pro-max", category: "phone", width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: IOS_PHONE_UA },
	{ id: "pixel-8", category: "phone", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidUa("Pixel 8", 14) },
	{ id: "pixel-9", category: "phone", width: 412, height: 923, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidUa("Pixel 9", 15) },
	{ id: "galaxy-z-fold-5", category: "phone", width: 344, height: 882, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: androidUa("SM-F946B", 14) },
	{ id: "ipad-mini", category: "tablet", width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_UA },
	{ id: "ipad-pro", category: "tablet", width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: IPAD_UA },
	{ id: "desktop-1080p", category: "desktop", width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: DESKTOP_UA },
	{ id: "desktop-4k", category: "desktop", width: 2560, height: 1440, deviceScaleFactor: 1.5, mobile: false, touch: false, userAgent: DESKTOP_UA },
	{ id: "tv-1080p", category: "tv", width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: TV_UA },
];

/** Ce que la matrice propose cochée la première fois : un appareil par famille courante. */
export const DEFAULT_MATRIX_DEVICE_IDS: readonly string[] = [
	"iphone-15",
	"pixel-8",
	"ipad-mini",
	"desktop-1080p",
];

/** Le preset d'un identifiant reçu, ou `undefined` : un id inconnu n'est jamais émulé. */
export function findDevicePreset(id: unknown): DevicePreset | undefined {
	if (typeof id !== "string") return undefined;
	return DEVICE_PRESETS.find((device) => device.id === id);
}
