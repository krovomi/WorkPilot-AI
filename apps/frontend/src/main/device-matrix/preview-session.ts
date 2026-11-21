/**
 * La session de l'aperçu prêtée à une capture de la matrice (#383).
 *
 * Une page derrière une connexion montrait l'écran de connexion : la matrice
 * rend dans une session vierge. Sur demande, le main copie dans la session
 * de la capture les cookies que l'aperçu enverrait au serveur de l'émulateur
 * — exactement ceux que `cookies.get({ url })` rend pour son origine, rien
 * d'un autre site. Le renderer ne les voit jamais ; la session de la capture
 * est en mémoire et vidée après chaque rendu. Le stockage local
 * (`localStorage`, IndexedDB) n'est pas copié.
 */
import { session } from "electron";

/** Au-delà, ce n'est plus la session d'une application qu'on teste. */
export const MAX_SHARED_COOKIES = 300;

/** Le `<webview>` de l'aperçu n'a pas de `partition` : il vit dans la session par défaut. */
const previewSession = () => session.defaultSession;

/** Une copie refusée par le serveur de cookies : la capture continue sans ce cookie. */
const ignore = () => undefined;

/**
 * Copie dans `target` les cookies de l'aperçu pour `origin`. Lire les
 * cookies de l'aperçu peut échouer : l'appelant en fait un échec nommé,
 * plutôt que de montrer comme « connectée » une page qui ne l'est pas.
 */
export async function sharePreviewCookies(target: Electron.Session, origin: string): Promise<number> {
	const cookies = (await previewSession().cookies.get({ url: origin })).slice(0, MAX_SHARED_COOKIES);
	const copies = cookies.map((cookie) =>
		target.cookies
			.set({
				url: origin,
				name: cookie.name,
				value: cookie.value,
				// Un cookie d'hôte reste un cookie d'hôte : sans `domain`.
				domain: cookie.hostOnly ? undefined : cookie.domain,
				path: cookie.path,
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				expirationDate: cookie.session ? undefined : cookie.expirationDate,
				sameSite: cookie.sameSite,
			})
			.then(() => true, ignore),
	);
	return (await Promise.all(copies)).filter(Boolean).length;
}
