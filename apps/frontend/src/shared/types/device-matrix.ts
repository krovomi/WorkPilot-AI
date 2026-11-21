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

/** Le sens de l'écran : la liste fermée de `DEVICE_ORIENTATIONS`. */
export type DeviceOrientation = "portrait" | "landscape";

/** Le format du fichier exporté : la liste fermée de `GRID_EXPORT_FORMATS`. */
export type DeviceGridExportFormat = "png" | "pdf";

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

/** Un profil de bridage réseau : la liste fermée de `NETWORK_PROFILES`. */
export type NetworkProfileId = "none" | "4g" | "fast-3g" | "slow-3g";

/** Un ralentissement du processeur : la liste fermée de `CPU_PROFILES`. */
export type CpuProfileId = "1x" | "2x" | "4x" | "6x";

export interface NetworkProfile {
	readonly id: NetworkProfileId;
	/** `null` : aucun bridage, le protocole des DevTools n'est pas appelé. */
	readonly conditions: {
		/** Latence ajoutée à chaque requête, en millisecondes. */
		readonly latencyMs: number;
		/** Débits, en octets par seconde. */
		readonly downloadBytesPerSecond: number;
		readonly uploadBytesPerSecond: number;
	} | null;
	/** Le temps laissé au chargement : un réseau lent en demande plus. */
	readonly loadTimeoutMs: number;
}

export interface CpuProfile {
	readonly id: CpuProfileId;
	/** Facteur de ralentissement (`Emulation.setCPUThrottlingRate`) ; 1 = aucun. */
	readonly rate: number;
}

/** Les bugs responsive que la lecture de la page sait reconnaître. */
export type ResponsiveIssueKind =
	| "horizontal-overflow"
	| "overflowing-media"
	| "small-touch-target"
	| "small-text"
	| "overlapping-elements"
	| "truncated-text"
	| "broken-navigation";

/** Un élément fautif, décrit sans son contenu. */
export interface ResponsiveIssueSample {
	/**
	 * `balise#id.classe` tronqué : de quoi le retrouver, rien de ce qu'il dit.
	 * Deux éléments qui se chevauchent : `a / b`, et la boîte est leur intersection.
	 */
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

/** Ce que le renderer envoie : un appareil connu, un chemin du serveur lancé, deux profils nommés, un sens, un choix de session. */
export interface DeviceCaptureRequest {
	readonly deviceId: string;
	/** Chemin absolu (`/compte?onglet=2`), résolu par le main sur l'origine du serveur. */
	readonly path: string;
	/** Un id de `NETWORK_PROFILES`, jamais des débits. */
	readonly network: string;
	/** Un id de `CPU_PROFILES`, jamais un facteur. */
	readonly cpu: string;
	/** Un sens de `DEVICE_ORIENTATIONS`, jamais une taille. */
	readonly orientation: string;
	/**
	 * Rendre avec les cookies que l'aperçu envoie à ce serveur (une page derrière
	 * une connexion) ; sinon une session vierge. Le main lit les cookies, le
	 * renderer ne les voit jamais.
	 */
	readonly previewSession: boolean;
}

export interface DeviceCapture {
	readonly deviceId: string;
	/** L'adresse réellement rendue (même origine que le serveur). */
	readonly url: string;
	/** `data:image/png;base64,…` aux pixels physiques de l'appareil. */
	readonly image: string;
	/** `null` quand la page n'a pas pu être lue (la capture reste valable). */
	readonly report: ResponsiveReport | null;
	/** Les profils appliqués à ce rendu. */
	readonly network: NetworkProfileId;
	readonly cpu: CpuProfileId;
	/** Durée du chargement (jusqu'à `load`), en millisecondes, sous ces profils. */
	readonly loadMs: number;
	/** Le sens rendu, et la fenêtre CSS qui en découle (celle de l'image et des exemples du rapport). */
	readonly orientation: DeviceOrientation;
	readonly width: number;
	readonly height: number;
	/** Rendu avec les cookies de l'aperçu. */
	readonly previewSession: boolean;
}

/** Les refus et les échecs, en liste fermée : le renderer en fait un texte traduit. */
export type DeviceCaptureError =
	| "invalid-request"
	| "unknown-device"
	| "unknown-throttling"
	| "not-running"
	| "invalid-path"
	| "busy"
	| "throttling-failed"
	| "session-failed"
	| "load-failed"
	| "capture-failed";

export type DeviceCaptureResult =
	| { readonly success: true; readonly data: DeviceCapture }
	| { readonly success: false; readonly error: DeviceCaptureError };

/** L'export de la grille : le renderer nomme les appareils affichés, rien d'autre. */
export interface DeviceGridExportRequest {
	readonly deviceIds: readonly string[];
	/** Un format de `GRID_EXPORT_FORMATS`. */
	readonly format: string;
	/** Encadrer sur chaque capture les éléments fautifs du rapport. */
	readonly markers: boolean;
}

export type DeviceGridExportError =
	| "invalid-request"
	| "nothing-to-export"
	| "busy"
	| "export-failed"
	| "write-failed";

/** `saved: false` : la personne a fermé la boîte de dialogue. Le chemin choisi n'est jamais renvoyé, seul son nom. */
export type DeviceGridExportResult =
	| { readonly success: true; readonly data: { readonly saved: false } | { readonly saved: true; readonly fileName: string } }
	| { readonly success: false; readonly error: DeviceGridExportError };
