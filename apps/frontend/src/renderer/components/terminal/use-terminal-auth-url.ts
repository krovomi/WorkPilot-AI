import type { Terminal as XTerm } from "@xterm/xterm";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { extractLatestAuthUrl } from "../../../shared/utils/terminal-links";
import { readTerminalText } from "./terminal-interactions";

/** Le temps laissé à un CLI pour finir de dessiner son écran avant relecture. */
const SCAN_DELAY_MS = 400;

export interface TerminalAuthUrl {
	/** La dernière URL de connexion affichée, ou `null`. */
	readonly authUrl: string | null;
	/** À appeler à chaque sortie : la relecture est regroupée. */
	readonly scanForAuthUrl: () => void;
}

/**
 * Surveille ce qu'affiche un terminal d'authentification et en extrait l'URL de
 * connexion.
 *
 * La relecture est regroupée parce qu'un CLI qui se dessine émet des dizaines
 * de fragments par seconde, et que relire le tampon à chacun d'eux ferait payer
 * un balayage complet par frappe de curseur. Elle lit le tampon — ce qui est
 * affiché — et jamais le flux, qui contient autant de versions de l'écran que
 * le programme s'est redessiné de fois.
 *
 * Une URL déjà trouvée est conservée quand l'écran ne la montre plus : elle
 * reste la réponse à « où dois-je aller ? » tant que l'authentification n'a pas
 * abouti, et c'est l'appelant qui décide de cesser de l'afficher.
 */
export function useTerminalAuthUrl(
	xtermRef: RefObject<XTerm | null>,
	delayMs: number = SCAN_DELAY_MS,
): TerminalAuthUrl {
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const scanForAuthUrl = useCallback(() => {
		if (timerRef.current) return;
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			const xterm = xtermRef.current;
			if (!xterm) return;
			try {
				const found = extractLatestAuthUrl(readTerminalText(xterm), {
					columns: xterm.cols,
				});
				if (found) setAuthUrl((previous) => (previous === found ? previous : found));
			} catch (error) {
				console.warn("[terminal] Failed to scan for an auth URL", error);
			}
		}, delayMs);
	}, [xtermRef, delayMs]);

	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, []);

	return { authUrl, scanForAuthUrl };
}
