/**
 * Ce qu'un terminal de l'application sait faire d'un lien et d'une sélection.
 *
 * Il y a quatre terminaux xterm.js dans le produit — celui des onglets, et un
 * par écran d'authentification — et ils répondaient différemment à la même
 * question. Le terminal des onglets ouvrait les liens par `openExternal` et
 * gérait Ctrl/Cmd+C ; les terminaux d'authentification, qui sont précisément
 * ceux où l'utilisateur a une URL à ouvrir et un code à copier, chargeaient un
 * `WebLinksAddon` nu et n'écoutaient aucun raccourci. Un clic y passait par
 * `window.open`, que le processus principal refuse, et Ctrl+C y envoyait un
 * SIGINT au CLI en cours d'authentification.
 *
 * Une seule réponse ici, chargée par les quatre.
 */

import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
	isLinux as checkIsLinux,
	isWindows as checkIsWindows,
} from "../../lib/os-detection";

/**
 * Écrit dans le presse-papiers, en disant si ça a marché.
 *
 * `navigator.clipboard` est la bonne réponse et elle n'est pas toujours là :
 * elle demande un contexte sécurisé, et elle rejette quand le document n'a pas
 * le focus — ce qui arrive exactement au moment où on copie depuis un terminal
 * qui vient de perdre le sien. Le repli `execCommand` est déprécié et il
 * fonctionne dans ces deux cas.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (!text) return false;

	try {
		await navigator.clipboard?.writeText(text);
		return true;
	} catch (error) {
		console.warn("[terminal] clipboard.writeText failed, falling back", error);
	}

	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.setAttribute("readonly", "");
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.select();
		const copied = document.execCommand("copy");
		document.body.removeChild(textarea);
		return copied;
	} catch (error) {
		console.warn("[terminal] clipboard fallback failed", error);
		return false;
	}
}

/**
 * Ouvre une URL du terminal dans le navigateur du système.
 *
 * Jamais `window.open` : le processus principal le refuse, et le repli Linux
 * (`xdg-open`, `gio open`…) ne vit que derrière `openExternal`. Le rejet est
 * journalisé plutôt qu'avalé — un lien qui ne fait rien et ne dit rien est le
 * pire des deux résultats.
 */
export function openTerminalUri(uri: string, context: string): void {
	const opener = window.electronAPI?.openExternal;
	if (!opener) {
		console.warn(`[${context}] openExternal unavailable, cannot open:`, uri);
		return;
	}
	opener(uri).catch((error: unknown) => {
		console.warn(`[${context}] Failed to open URL:`, uri, error);
	});
}

/** Un `WebLinksAddon` qui ouvre par `openExternal`. */
export function createTerminalWebLinksAddon(context: string): WebLinksAddon {
	return new WebLinksAddon((_event, uri) => {
		openTerminalUri(uri, context);
		// `false` empêche le `window.open` par défaut de l'addon.
		return false;
	});
}

/**
 * Copie la sélection courante. Rend `false` quand il n'y en a pas — ce que
 * l'appelant lit pour décider si la touche reste disponible pour autre chose.
 * L'échec de l'écriture, lui, est journalisé : il arrive après coup.
 */
export function copySelection(xterm: XTerm): boolean {
	if (!xterm.hasSelection()) return false;
	const selection = xterm.getSelection();
	if (!selection) return false;
	void copyTextToClipboard(selection).then((copied) => {
		if (!copied) {
			console.error(
				"[terminal] Failed to copy selection:",
				new Error("clipboard unavailable"),
			);
		}
	});
	return true;
}

/** Colle le presse-papiers dans le terminal. */
export function pasteIntoTerminal(xterm: XTerm): void {
	navigator.clipboard
		?.readText()
		.then((text) => {
			if (text) xterm.paste(text);
		})
		.catch((error: unknown) => {
			console.error("[terminal] Failed to read clipboard:", error);
		});
}

export interface ClipboardPlatform {
	readonly isWindows: boolean;
	readonly isLinux: boolean;
}

/** La plateforme telle que le renderer la voit. */
export function detectClipboardPlatform(): ClipboardPlatform {
	return { isWindows: checkIsWindows(), isLinux: checkIsLinux() };
}

/**
 * Le verdict d'un raccourci presse-papiers, ou `undefined` quand l'évènement
 * n'en est pas un — auquel cas l'appelant continue sa propre chaîne.
 *
 * Le verdict rendu est celui qu'attend `attachCustomKeyEventHandler` : `false`
 * pour « xterm ne doit pas traiter cette touche », `true` pour « laisse-la
 * passer ». Un Ctrl+C sans sélection passe : c'est un signal d'interruption,
 * et c'est la seule façon d'arrêter ce qui tourne.
 */
export function handleClipboardKeyEvent(
	xterm: XTerm,
	event: KeyboardEvent,
	platform: ClipboardPlatform = detectClipboardPlatform(),
): boolean | undefined {
	if (event.type !== "keydown") return undefined;

	const key = event.key.toLowerCase();
	const isMod = event.metaKey || event.ctrlKey;

	// Ctrl+Shift+C / Ctrl+Shift+V : la convention Linux, vérifiée avant les
	// raccourcis sans Shift pour ne pas être rendue inatteignable par eux.
	if (platform.isLinux && event.ctrlKey && event.shiftKey && key === "c") {
		copySelection(xterm);
		// Consommé dans tous les cas : Ctrl+Shift+C n'envoie aucun signal utile.
		return false;
	}
	if (platform.isLinux && event.ctrlKey && event.shiftKey && key === "v") {
		event.preventDefault();
		pasteIntoTerminal(xterm);
		return false;
	}

	// Cmd/Ctrl+C : copie s'il y a une sélection, interruption sinon.
	if (isMod && !event.shiftKey && key === "c") {
		return !copySelection(xterm);
	}

	// Ctrl+V là où c'est le geste de collage attendu ; sur macOS, Cmd+V est déjà
	// traité par xterm.js.
	if (
		event.ctrlKey &&
		!event.shiftKey &&
		key === "v" &&
		(platform.isWindows || platform.isLinux)
	) {
		event.preventDefault();
		pasteIntoTerminal(xterm);
		return false;
	}

	return undefined;
}

/**
 * OSC 52 : la séquence par laquelle un programme demande au terminal de mettre
 * quelque chose dans le presse-papiers. xterm.js ne l'implémente pas.
 *
 * C'est ce que déclenche le « (c to copy) » d'un CLI d'authentification : sans
 * ce gestionnaire, la touche est bien lue par le programme, la séquence bien
 * émise, et rien n'arrive dans le presse-papiers — un échec parfaitement
 * silencieux, sur le geste même que le programme vient de proposer.
 */
export function attachOsc52Clipboard(xterm: XTerm): void {
	if (!xterm.parser?.registerOscHandler) return;
	xterm.parser.registerOscHandler(52, (data: string) => {
		// Forme : `<cibles>;<charge base64>`, `?` demandant une lecture — qu'on
		// n'honore pas : rendre le presse-papiers de l'utilisateur à un programme
		// qui le demande est une fuite, pas une fonctionnalité.
		const separator = data.indexOf(";");
		if (separator === -1) return false;
		const payload = data.slice(separator + 1);
		if (!payload || payload === "?") return false;

		try {
			const bytes = Uint8Array.from(atob(payload), (char) =>
				char.charCodeAt(0),
			);
			const text = new TextDecoder().decode(bytes);
			if (text) void copyTextToClipboard(text);
		} catch (error) {
			console.warn("[terminal] Invalid OSC 52 payload", error);
			return false;
		}
		return true;
	});
}

/**
 * Le texte tel qu'il est affiché, lignes repliées recollées.
 *
 * Lu depuis le tampon et non depuis le flux : un CLI qui se redessine réécrit
 * dix fois les mêmes lignes en déplaçant le curseur, et le flux brut, une fois
 * les séquences retirées, colle ces versions bout à bout. Le tampon, lui, est
 * ce que l'utilisateur a sous les yeux.
 */
export function readTerminalText(xterm: XTerm, maxLines = 600): string {
	const buffer = xterm.buffer?.active;
	if (!buffer) return "";

	const end = buffer.length;
	const start = Math.max(0, end - maxLines);
	const lines: string[] = [];

	for (let index = start; index < end; index++) {
		const line = buffer.getLine(index);
		if (!line) continue;
		const text = line.translateToString(true);
		// `isWrapped` marque un repli fait par xterm.js : la ligne prolonge la
		// précédente, et les recoller ici évite de le redécouvrir par la largeur.
		if (line.isWrapped && lines.length > 0) {
			lines[lines.length - 1] += text;
		} else {
			lines.push(text);
		}
	}

	return lines.join("\n");
}

/**
 * Tout ce qu'un terminal simple — un écran d'authentification — doit savoir
 * faire : ouvrir un lien, copier, coller, honorer OSC 52.
 */
export function attachTerminalInteractions(
	xterm: XTerm,
	context: string,
	platform: ClipboardPlatform = detectClipboardPlatform(),
): WebLinksAddon {
	const webLinksAddon = createTerminalWebLinksAddon(context);
	xterm.loadAddon(webLinksAddon);
	attachOsc52Clipboard(xterm);
	xterm.attachCustomKeyEventHandler((event) => {
		const verdict = handleClipboardKeyEvent(xterm, event, platform);
		return verdict === undefined ? true : verdict;
	});
	return webLinksAddon;
}
