/**
 * La matrice d'appareils de l'émulateur (#383) : ce que le renderer demande,
 * ce que le main rend.
 *
 * Le renderer nomme un appareil de `DEVICE_PRESETS` et un chemin ; le main
 * prend l'origine du serveur qu'il a lancé, rend la page dans une fenêtre
 * cachée émulant l'appareil, la photographie et la fait lire par un script en
 * lecture seule. Rien de ce que la page répond n'est une instruction : le
 * rapport est remis en forme et borné avant de quitter le main.
 */

export type DeviceCategory = "phone" | "tablet" | "desktop" | "tv";

/** Un appareil prêt à l'emploi : sa fenêtre CSS, sa densité, son navigateur. */
export interface DevicePreset {
	/** Identifiant stable, aussi la clé i18n `appEmulator:devices.<id>`. */
	readonly id: string;
	readonly category: DeviceCategory;
	/** Largeur de la fenêtre CSS, en pixels CSS. */
	readonly width: number;
	/** Hauteur de la fenêtre CSS, en pixels CSS. */
	readonly height: number;
	/** Pixels physiques par pixel CSS. */
	readonly deviceScaleFactor: number;
	/** Navigateur mobile : `<meta name="viewport">` appliqué, barres de défilement superposées. */
	readonly mobile: boolean;
	/** Écran tactile : `pointer: coarse`, évènements tactiles, cibles de 44 px vérifiées. */
	readonly touch: boolean;
	readonly userAgent: string;
}

/** Les bugs responsive que la lecture de la page sait reconnaître. */
export type ResponsiveIssueKind =
	| "horizontal-overflow"
	| "overflowing-media"
	| "small-touch-target"
	| "small-text";

/** Un élément fautif, décrit sans son contenu. */
export interface ResponsiveIssueSample {
	/** `balise#id.classe` tronqué : de quoi le retrouver, rien de ce qu'il dit. */
	readonly selector: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ResponsiveIssue {
	readonly kind: ResponsiveIssueKind;
	/** Combien d'éléments la lecture a trouvés (les exemples sont bornés). */
	readonly count: number;
	readonly samples: readonly ResponsiveIssueSample[];
}

export interface ResponsiveReport {
	readonly viewportWidth: number;
	/** Largeur du document : au-delà de la fenêtre, la page défile de côté. */
	readonly scrollWidth: number;
	/** Éléments lus (la lecture s'arrête à un plafond). */
	readonly scanned: number;
	/** La page a plus d'éléments que le plafond : le rapport est partiel. */
	readonly truncated: boolean;
	readonly issues: readonly ResponsiveIssue[];
}

/** Ce que le renderer envoie : un appareil connu et un chemin du serveur lancé. */
export interface DeviceCaptureRequest {
	readonly deviceId: string;
	/** Chemin absolu (`/compte?onglet=2`), résolu par le main sur l'origine du serveur. */
	readonly path: string;
}

export interface DeviceCapture {
	readonly deviceId: string;
	/** L'adresse réellement rendue (même origine que le serveur). */
	readonly url: string;
	/** `data:image/png;base64,…` aux pixels physiques de l'appareil. */
	readonly image: string;
	/** `null` quand la page n'a pas pu être lue (la capture reste valable). */
	readonly report: ResponsiveReport | null;
}

/** Les refus et les échecs, en liste fermée : le renderer en fait un texte traduit. */
export type DeviceCaptureError =
	| "invalid-request"
	| "unknown-device"
	| "not-running"
	| "invalid-path"
	| "busy"
	| "load-failed"
	| "capture-failed";

export type DeviceCaptureResult =
	| { readonly success: true; readonly data: DeviceCapture }
	| { readonly success: false; readonly error: DeviceCaptureError };
