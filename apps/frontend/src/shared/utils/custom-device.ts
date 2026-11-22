/**
 * Les appareils personnalisés et les personas de la matrice (#383) : les
 * bornes de chaque champ, appliquées par le main à tout ce qu'il reçoit ou
 * relit sur le disque, et par le renderer pour dire tout de suite ce qui ne
 * passera pas.
 *
 * Le main reste seul juge : un brouillon hors bornes est refusé, quel que soit
 * ce que le formulaire a laissé passer.
 */
import type { CustomDeviceDraft, CustomDevicePreset } from "../types/device-library";
import type { DeviceCategory } from "../types/device-matrix";

export const CUSTOM_DEVICE_LIMITS = {
	/** Côté de la fenêtre CSS, en pixels CSS : d'une petite montre à un écran 4K à 100 %. */
	minSide: 240,
	maxSide: 3840,
	/** Pixels physiques par pixel CSS. */
	minScale: 1,
	maxScale: 4,
	maxName: 40,
	maxUserAgent: 512,
	/** Au-delà, la liste ne sert plus à choisir. */
	maxDevices: 20,
} as const;

/** Les personas gardés au plus. */
export const MAX_PERSONAS = 10;

/** L'id qu'un appareil personnalisé reçoit du main. */
export const CUSTOM_DEVICE_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** L'id qu'un persona reçoit du main. */
export const PERSONA_ID = /^persona-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Caractères de contrôle (C0, DEL, C1) et marques de direction qui retourneraient une légende. */
function unsafeCharacter(char: string): boolean {
	const code = char.charCodeAt(0);
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x200e ||
		code === 0x200f ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}
/** Un user agent est un en-tête HTTP : ASCII imprimable seulement. */
function printableAscii(value: string): boolean {
	return Array.from(value).every((char) => {
		const code = char.charCodeAt(0);
		return code >= 0x20 && code <= 0x7e;
	});
}

/** Un nom affiché (appareil, persona) : espaces de bord retirés, 1 à 40 caractères sûrs ; `null` sinon. */
export function readDisplayName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (name.length === 0 || name.length > CUSTOM_DEVICE_LIMITS.maxName || Array.from(name).some(unsafeCharacter)) return null;
	return name;
}

function readSide(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	return value >= CUSTOM_DEVICE_LIMITS.minSide && value <= CUSTOM_DEVICE_LIMITS.maxSide ? value : null;
}

function readScale(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < CUSTOM_DEVICE_LIMITS.minScale || value > CUSTOM_DEVICE_LIMITS.maxScale) return null;
	return Math.round(value * 1000) / 1000;
}

function readUserAgent(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const userAgent = value.trim();
	if (userAgent === "" || userAgent.length > CUSTOM_DEVICE_LIMITS.maxUserAgent || !printableAscii(userAgent)) return null;
	return userAgent;
}

/** Le brouillon dans ses bornes, ou `null` : un champ manquant, hors bornes ou d'un autre type refuse tout. */
export function readCustomDeviceDraft(raw: unknown): CustomDeviceDraft | null {
	if (!raw || typeof raw !== "object") return null;
	const fields = raw as Record<string, unknown>;
	const name = readDisplayName(fields.name);
	const width = readSide(fields.width);
	const height = readSide(fields.height);
	const deviceScaleFactor = readScale(fields.deviceScaleFactor);
	const userAgent = readUserAgent(fields.userAgent);
	if (name === null || width === null || height === null || deviceScaleFactor === null || userAgent === null) {
		return null;
	}
	if (typeof fields.mobile !== "boolean" || typeof fields.touch !== "boolean") return null;
	return { name, width, height, deviceScaleFactor, mobile: fields.mobile, touch: fields.touch, userAgent };
}

/** La famille d'un appareil décrit : un navigateur mobile étroit est un téléphone, large une tablette. */
export function categoryOf(draft: Pick<CustomDeviceDraft, "width" | "height" | "mobile">): DeviceCategory {
	if (!draft.mobile) return "desktop";
	return Math.min(draft.width, draft.height) < 600 ? "phone" : "tablet";
}

/** L'appareil émulé pour un brouillon déjà relu. */
export function customDevice(id: string, draft: CustomDeviceDraft): CustomDevicePreset {
	return { id, category: categoryOf(draft), ...draft };
}

/** Un appareil relu sur le disque : un id du main et un brouillon dans ses bornes ; `null` sinon. */
export function readStoredCustomDevice(raw: unknown): CustomDevicePreset | null {
	if (!raw || typeof raw !== "object") return null;
	const id = (raw as Record<string, unknown>).id;
	if (typeof id !== "string" || !CUSTOM_DEVICE_ID.test(id)) return null;
	const draft = readCustomDeviceDraft(raw);
	return draft ? customDevice(id, draft) : null;
}
