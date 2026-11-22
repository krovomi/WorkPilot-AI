/**
 * Ce que la matrice d'appareils garde d'une session à l'autre (#383) : les
 * appareils personnalisés et les personas, et la relecture d'une page à
 * plusieurs largeurs.
 *
 * Un appareil personnalisé est décrit une fois par la personne (fenêtre,
 * densité, user agent), relu dans ses bornes par le main, qui lui donne un id
 * et le garde ; ensuite le renderer le nomme, comme un appareil du catalogue.
 * Un persona est un jeu de cookies enregistré depuis la session de l'aperçu,
 * chiffré par le trousseau de l'OS : le renderer n'en voit que le nom.
 */
import type { DeviceCaptureError, DevicePreset, ResponsiveIssueKind } from "./device-matrix";

/** Ce que la personne saisit pour un appareil à elle. */
export interface CustomDeviceDraft {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly deviceScaleFactor: number;
	readonly mobile: boolean;
	readonly touch: boolean;
	readonly userAgent: string;
}

/** Un appareil personnalisé : un preset dont l'id (`custom-<uuid>`) vient du main, et qui porte son nom. */
export type CustomDevicePreset = DevicePreset & { readonly name: string };

export type CustomDeviceError = "invalid-request" | "invalid-device" | "too-many" | "unknown-device" | "write-failed";

/** La liste après l'opération, ou un refus nommé. */
export type CustomDeviceResult =
	| { readonly success: true; readonly data: readonly CustomDevicePreset[] }
	| { readonly success: false; readonly error: CustomDeviceError };

/** Un persona tel que le renderer le voit : jamais un cookie. */
export interface PersonaSummary {
	readonly id: string;
	readonly name: string;
	/** `schéma://hôte` du serveur où il a été enregistré : les cookies ignorent le port. */
	readonly host: string;
	readonly cookieCount: number;
	/** Date d'enregistrement, en millisecondes depuis l'epoch. */
	readonly savedAt: number;
}

export type PersonaError =
	| "invalid-request"
	| "not-running"
	| "encryption-unavailable"
	| "session-failed"
	| "no-cookies"
	| "too-many"
	| "unknown-persona"
	| "write-failed";

export type PersonaResult =
	| { readonly success: true; readonly data: readonly PersonaSummary[] }
	| { readonly success: false; readonly error: PersonaError };

/** La relecture d'une page à plusieurs largeurs : un appareil nommé, un chemin, une session. */
export interface BreakpointScanRequest {
	readonly deviceId: string;
	readonly path: string;
	readonly previewSession: boolean;
	readonly persona: string | null;
}

/** Ce que la lecture a trouvé à une largeur : des comptes, sans les exemples. */
export interface BreakpointStep {
	readonly width: number;
	/** Largeur du document à cette fenêtre. */
	readonly scrollWidth: number;
	readonly truncated: boolean;
	readonly issues: readonly { readonly kind: ResponsiveIssueKind; readonly count: number }[];
}

export interface BreakpointScan {
	readonly deviceId: string;
	readonly url: string;
	/** Les seuils de largeur que les feuilles de style de la page déclarent (`@media`), en pixels CSS. */
	readonly breakpoints: readonly number[];
	/** Une lecture par largeur, de la plus étroite à la plus large. */
	readonly steps: readonly BreakpointStep[];
}

export type BreakpointScanResult =
	| { readonly success: true; readonly data: BreakpointScan }
	| { readonly success: false; readonly error: DeviceCaptureError };

/** Une vue vivante : un `<webview>` de la matrice, nommé par l'id de son contenu, et l'appareil qu'il émule. */
export interface LiveViewRequest {
	readonly webContentsId: number;
	readonly deviceId: string;
	/** Un sens de `DEVICE_ORIENTATIONS`. */
	readonly orientation: string;
}

export type LiveViewError =
	| "invalid-request"
	| "unknown-device"
	| "unknown-view"
	| "not-running"
	| "elsewhere"
	| "emulation-failed";

export type LiveViewResult =
	| { readonly success: true; readonly data: { readonly reloaded: boolean } }
	| { readonly success: false; readonly error: LiveViewError };

/** La part défilée d'une page, de 0 à 1 sur chaque axe. */
export interface LiveScroll {
	readonly x: number;
	readonly y: number;
}

export type LiveScrollResult =
	| { readonly success: true; readonly data: LiveScroll }
	| { readonly success: false; readonly error: LiveViewError };

/** Défiler ces vues à la même part. */
export interface LiveScrollRequest extends LiveScroll {
	readonly webContentsIds: readonly number[];
}
