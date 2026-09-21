/**
 * Retrouver une URL dans ce qu'un terminal affiche.
 *
 * Une URL d'authentification fait deux à trois cents caractères ; un terminal
 * en affiche quatre-vingts par ligne. Elle arrive donc à l'écran coupée en
 * morceaux — par xterm.js quand le programme laisse le terminal replier, par le
 * programme lui-même (Ink, Bubbletea…) quand il calcule son propre repli et
 * émet ses propres retours à la ligne. Dans les deux cas, la sélectionner à la
 * souris rend trois fragments, et une coupure tombe au milieu d'un `%3A`.
 *
 * Ce module rend l'URL entière à partir du texte rendu, pour qu'une surface
 * puisse l'ouvrir ou la copier d'un seul geste. Il ne lit que du texte — ni
 * modèle, ni réseau — donc l'appelant peut poser la question à chaque sortie.
 */

import { stripAnsiCodes } from "./ansi-sanitizer";

/** Ce qui ouvre une URL dans un flux de terminal. */
const URL_SCHEME = /https?:\/\//gi;

/**
 * La ponctuation qu'une phrase pose derrière une URL. Retirée du bout, jamais
 * du milieu : `…&state=abc.` est une URL suivie d'un point, `…/a.b` ne l'est
 * pas.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"»)\]}]+$/;

/**
 * Ce qui fait d'une URL une URL de connexion. Le lien qu'on propose d'ouvrir
 * est celui qui débloque l'utilisateur ; la documentation citée trois lignes
 * plus haut par le même programme n'a rien à faire dans ce bandeau.
 */
const AUTH_URL_HINT =
	/(oauth|authoriz|authentic|login|log-in|sign-?in|signin|device|activate|verif|callback|connect)/i;

export interface TerminalUrlOptions {
	/**
	 * La largeur du terminal. Elle sert à reconnaître un repli de colonne : une
	 * ligne qui l'atteint a été coupée, une ligne plus courte s'est terminée
	 * d'elle-même. Sans elle, la plus longue ligne du texte en tient lieu.
	 */
	readonly columns?: number;
}

/** Un caractère qu'une URL peut contenir — tout sauf une césure ou un blanc. */
function isUrlChar(char: string): boolean {
	return !/[\s<>"'`]/.test(char) && char.charCodeAt(0) > 0x1f;
}

/** Lit une URL depuis `start`, et dit si elle a couru jusqu'au bout de ligne. */
function readUrlRun(
	line: string,
	start: number,
): { value: string; ranToEndOfLine: boolean } {
	let end = start;
	while (end < line.length && isUrlChar(line[end])) end++;
	return { value: line.slice(start, end), ranToEndOfLine: end === line.length };
}

/**
 * Une ligne assez pleine pour avoir été coupée. Deux caractères de jeu, parce
 * qu'un programme qui calcule son propre repli garde parfois une colonne pour
 * un caractère large.
 */
function looksWrapped(line: string, wrapWidth: number): boolean {
	return wrapWidth > 0 && line.length >= wrapWidth - 2;
}

/** Valide et normalise un candidat ; rend `null` si ce n'en était pas une. */
function normalizeUrl(candidate: string): string | null {
	const trimmed = candidate.replace(TRAILING_PUNCTUATION, "");
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		if (!parsed.hostname) return null;
		return trimmed;
	} catch {
		return null;
	}
}

/**
 * Toutes les URL du texte rendu, dans l'ordre d'apparition et sans doublon.
 *
 * Les fragments d'une URL repliée sont recollés : on continue sur la ligne
 * suivante tant que la précédente s'est arrêtée net au bord du terminal et que
 * la suivante reprend sans espace — un repli ne laisse ni blanc ni indentation.
 */
export function extractTerminalUrls(
	text: string,
	options: TerminalUrlOptions = {},
): string[] {
	if (!text) return [];

	const lines = stripAnsiCodes(text)
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));

	const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
	const wrapWidth =
		options.columns && options.columns > 0 ? options.columns : widest;

	const found: string[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		for (const match of line.matchAll(URL_SCHEME)) {
			const start = match.index ?? 0;
			let run = readUrlRun(line, start);
			let candidate = run.value;
			let cursor = index;

			while (
				run.ranToEndOfLine &&
				looksWrapped(lines[cursor], wrapWidth) &&
				cursor + 1 < lines.length
			) {
				const next = lines[cursor + 1];
				if (!next || !isUrlChar(next[0])) break;
				// Une ligne qui commence par un schéma est une deuxième URL, pas la
				// suite de la première — une URL pleine largeur suivie d'une autre
				// est exactement ce qu'un CLI qui se redessine produit.
				if (/^https?:\/\//i.test(next)) break;
				run = readUrlRun(next, 0);
				candidate += run.value;
				cursor++;
			}

			const url = normalizeUrl(candidate);
			if (url && !seen.has(url)) {
				seen.add(url);
				found.push(url);
			}
		}
	}

	return found;
}

/**
 * La dernière URL de connexion affichée, ou `null`.
 *
 * La dernière et non la première : un programme qui échoue puis réessaie écrit
 * deux URL, et celle qui vaut quelque chose est la plus récente. Quand aucune
 * ne se nomme comme une URL de connexion, on ne propose rien plutôt que
 * d'ouvrir la première URL venue.
 */
export function extractLatestAuthUrl(
	text: string,
	options: TerminalUrlOptions = {},
): string | null {
	const candidates = extractTerminalUrls(text, options).filter((url) =>
		AUTH_URL_HINT.test(url),
	);
	return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}
