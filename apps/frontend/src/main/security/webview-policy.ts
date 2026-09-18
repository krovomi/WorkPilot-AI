/**
 * Ce qu'un `<webview>` a le droit d'être, et ce qu'une page a le droit de
 * demander à la machine.
 *
 * Les deux décisions vivent ici plutôt que dans une closure de `index.ts`
 * parce qu'elles sont des règles, pas du câblage : une règle se lit, se teste
 * et se modifie en un endroit. `index.ts` les branche sur
 * `will-attach-webview` et sur la session, et ne décide de rien.
 *
 * **Pourquoi `will-attach-webview` existe.** `webviewTag: true` est nécessaire
 * à l'aperçu de l'émulateur — c'est ce qui permet d'afficher une page qui
 * envoie `X-Frame-Options`. Mais une balise `<webview>` porte ses propres
 * `webPreferences` dans ses attributs HTML : sans ce handler, c'est le
 * renderer qui les choisit. Une injection DOM — une dépendance compromise, un
 * `dangerouslySetInnerHTML` oublié — pose
 * `<webview nodeintegration preload="file:///tmp/x.js">` et obtient Node dans
 * le processus principal, par-dessus le `sandbox: true` et le
 * `contextIsolation: true` que la fenêtre principale, elle, respecte. Le
 * renderer décide *quoi* afficher ; jamais *avec quels privilèges*.
 *
 * **Pourquoi les permissions.** Electron **accorde** par défaut toute
 * permission qu'une page demande. La fenêtre principale est notre code, mais
 * l'aperçu charge l'application de l'utilisateur — et, depuis la barre
 * d'adresse, n'importe quelle page. Celle-ci pouvait donc obtenir la caméra,
 * le micro, la position ou un périphérique USB sans que personne ne soit
 * consulté.
 */

/**
 * Les schémas qu'un aperçu peut légitimement charger : le serveur de dev de
 * l'utilisateur (`http`/`https`), le diagramme archify rendu sur disque
 * (`file`), et la page vide d'avant la première navigation.
 */
const ALLOWED_WEBVIEW_SCHEMES: ReadonlySet<string> = new Set([
	"http:",
	"https:",
	"file:",
	"about:",
	"data:",
]);

/**
 * Une liste d'autorisation, pas d'interdiction : une permission ajoutée par
 * une version future de Chromium est refusée tant que personne n'a décidé le
 * contraire. C'est le bon sens de lecture pour ce fichier — l'inverse fait
 * qu'une mise à jour du moteur élargit silencieusement ce que l'aperçu peut
 * demander.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
	"clipboard-read",
	"clipboard-sanitized-write",
	"fullscreen",
	"notifications",
]);

/** Les `webPreferences` qu'un `<webview>` reçoit, quoi que dise le DOM. */
export const WEBVIEW_ENFORCED_PREFERENCES = {
	nodeIntegration: false,
	nodeIntegrationInSubFrames: false,
	contextIsolation: true,
	sandbox: true,
	webSecurity: true,
	allowRunningInsecureContent: false,
	experimentalFeatures: false,
} as const;

/** Les attributs qui feraient exécuter du code à nous dans la page affichée. */
const STRIPPED_PREFERENCE_KEYS = ["preload", "preloadURL"] as const;

/**
 * Réécrit les préférences qu'Electron s'apprête à donner au `<webview>`.
 *
 * Mute l'objet reçu : c'est ce qu'attend `will-attach-webview`, qui lit
 * l'objet après le retour du handler.
 */
export function enforceWebviewPreferences(
	webPreferences: Record<string, unknown>,
): void {
	Object.assign(webPreferences, WEBVIEW_ENFORCED_PREFERENCES);
	for (const key of STRIPPED_PREFERENCE_KEYS) {
		delete webPreferences[key];
	}
}

/**
 * Le `src` demandé est-il d'un schéma qu'un aperçu peut charger ?
 *
 * Un `src` vide est accepté — il n'y a rien à charger, donc rien à autoriser,
 * et c'est l'état d'un `<webview>` monté avant sa première navigation.
 */
export function isWebviewSourceAllowed(src: string | undefined | null): boolean {
	if (!src) return true;
	try {
		return ALLOWED_WEBVIEW_SCHEMES.has(new URL(src).protocol);
	} catch {
		return false;
	}
}

/** Cette permission est-elle accordée, à n'importe quelle page ? */
export function isPermissionGranted(permission: string): boolean {
	return GRANTED_PERMISSIONS.has(permission);
}
