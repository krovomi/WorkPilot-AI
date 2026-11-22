/**
 * Les vues vivantes de la matrice d'appareils (#383) : plusieurs `<webview>`
 * de l'aperçu, chacun émulant un appareil, qui défilent ensemble.
 *
 * Le renderer donne l'identifiant d'un `<webview>` qu'il héberge ; le main
 * vérifie ce qu'il nomme (`resolvePreview` : un invité de type webview de la
 * fenêtre qui demande) et qu'il montre une page du serveur de l'émulateur,
 * puis pose l'appareil par le débogueur de l'invité, comme pour une capture
 * (fenêtre, densité, tactile, user agent). Le `<webview>` reste sous
 * `security/webview-policy.ts` (sans preload, sans Node, en bac à sable) :
 * rien n'est ajouté à sa configuration.
 *
 * Le défilement passe par le main : un script constant lit, dans un monde
 * isolé, la part de la page défilée (deux nombres de 0 à 1), et un autre
 * défile les autres vues à la même part. Aucun texte de la page ne sort, et
 * aucun texte reçu n'entre dans un script : seuls des nombres bornés.
 */
import type { WebContents } from "electron";
import type { DevicePreset } from "../../shared/types/device-matrix";
import { type Send, emulate } from "./device-capture";

/** Monde isolé des scripts de défilement : même DOM, pas les globales de la page. */
const LIVE_WORLD_ID = 1384;

export type LiveViewFailure = "emulation-failed";

export class LiveViewError extends Error {
	constructor(readonly code: LiveViewFailure) {
		super(code);
	}
}

/** La part défilée d'une page, sur chaque axe, de 0 (début) à 1 (fin). */
export interface ScrollShare {
	readonly x: number;
	readonly y: number;
}

export const READ_SCROLL = `(function () {
  var root = document.scrollingElement || document.documentElement;
  var spanX = root.scrollWidth - window.innerWidth;
  var spanY = root.scrollHeight - window.innerHeight;
  return { x: spanX > 0 ? window.scrollX / spanX : 0, y: spanY > 0 ? window.scrollY / spanY : 0 };
})()`;

/** Le script qui défile à une part : les nombres sont relus et écrits par le main. */
export function buildScrollTo(share: ScrollShare): string {
	return `(function (s) {
  var root = document.scrollingElement || document.documentElement;
  window.scrollTo(s.x * Math.max(0, root.scrollWidth - window.innerWidth), s.y * Math.max(0, root.scrollHeight - window.innerHeight));
  return true;
})(${JSON.stringify({ x: share.x, y: share.y })})`;
}

/** Une part bornée, ou `null` : ce que la page répond est une donnée. */
export function readShare(raw: unknown): ScrollShare | null {
	if (!raw || typeof raw !== "object") return null;
	const { x, y } = raw as Record<string, unknown>;
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
	const clamp = (value: number) => Math.min(1, Math.max(0, value));
	return { x: clamp(x), y: clamp(y) };
}

/** L'invité montre une page de cette origine. */
export function showsOrigin(guest: WebContents, origin: string): boolean {
	try {
		return new URL(guest.getURL()).origin === origin;
	} catch {
		return false;
	}
}

/**
 * Pose `device` sur l'invité. Le user agent change l'en-tête et
 * `navigator.userAgent` au chargement suivant : quand il change, la vue est
 * rechargée une fois (`reloaded`), et le prochain appel ne recharge plus.
 */
export async function emulateLiveView(guest: WebContents, device: DevicePreset): Promise<{ reloaded: boolean }> {
	try {
		if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
		const send: Send = (method, params) => guest.debugger.sendCommand(method, params);
		await emulate(send, device);
	} catch {
		throw new LiveViewError("emulation-failed");
	}
	if (guest.getUserAgent() === device.userAgent) return { reloaded: false };
	guest.setUserAgent(device.userAgent);
	guest.reload();
	return { reloaded: true };
}

export async function readLiveScroll(guest: WebContents): Promise<ScrollShare | null> {
	const raw = await guest.executeJavaScriptInIsolatedWorld(LIVE_WORLD_ID, [{ code: READ_SCROLL }]).catch(() => null);
	return readShare(raw);
}

/** Défile chaque invité à la même part ; une vue qui ne répond pas est laissée. */
export async function setLiveScroll(guests: readonly WebContents[], share: ScrollShare): Promise<void> {
	const code = buildScrollTo(share);
	await Promise.all(
		guests.map((guest) => guest.executeJavaScriptInIsolatedWorld(LIVE_WORLD_ID, [{ code }]).catch(() => null)),
	);
}
