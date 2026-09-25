import { type ChildProcess, spawn } from "node:child_process";
import { shell } from "electron";
import { isLinux } from "./platform";

/**
 * Ouvrir une URL dans le navigateur du système.
 *
 * `shell.openExternal` est la bonne réponse partout sauf sur un Linux où
 * `xdg-utils` n'est pas installé, où le portail XDG n'est pas joignable, ou où
 * l'application tourne dans un bac à sable : Electron y rend une promesse
 * rejetée — et l'appelant, qui n'avait rien d'autre à proposer, avalait le
 * rejet. Un bouton qui ne fait rien et ne dit rien est la pire des deux
 * options : on essaie donc les lanceurs que la machine a réellement, et on
 * nomme l'échec quand il n'y en a aucun.
 */

/**
 * Les schémas qu'une page peut demander d'ouvrir.
 *
 * `obsidian:` ouvre une note du cerveau partagé dans Obsidian (carte de tâche
 * du Kanban). Il ne lance que l'application Obsidian, jamais un programme
 * arbitraire — à la différence de `file:`, qui reste refusé.
 */
export const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
	"http:",
	"https:",
	"obsidian:",
]);

/**
 * Les lanceurs essayés sur Linux, du plus général au plus concret. `xdg-open`
 * d'abord parce qu'il respecte le choix de navigateur par défaut de
 * l'utilisateur ; les navigateurs nommés en dernier parce qu'ouvrir Firefox
 * chez quelqu'un qui a choisi Chrome vaut mieux que ne rien ouvrir.
 */
export const LINUX_OPENERS: readonly (readonly string[])[] = [
	["xdg-open"],
	["gio", "open"],
	["gnome-open"],
	["kde-open"],
	["x-www-browser"],
	["sensible-browser"],
	["firefox"],
	["google-chrome"],
	["chromium"],
];

/** Au-delà, on considère que le lanceur a rendu la main au navigateur. */
const OPENER_SETTLE_MS = 2500;

export interface OpenExternalDeps {
	openExternal: (url: string) => Promise<void>;
	linux: boolean;
	spawnOpener: (command: string, args: string[]) => ChildProcess;
}

const defaultDeps: OpenExternalDeps = {
	openExternal: (url) => shell.openExternal(url),
	linux: isLinux(),
	spawnOpener: (command, args) =>
		spawn(command, args, { stdio: "ignore", windowsHide: true }),
};

/**
 * Valide l'URL et rend son objet `URL`. Lève avec un message qui distingue les
 * deux fautes possibles — une URL illisible et un schéma refusé ne se corrigent
 * pas de la même façon.
 */
export function parseExternalUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL format: ${url}`);
	}
	if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(`Unsafe URL protocol: ${parsed.protocol}`);
	}
	return parsed;
}

/**
 * Lance un ouvreur et attend son verdict. Un `ENOENT` dit que le binaire n'est
 * pas là, un code non nul qu'il n'a pas su quoi faire de l'URL ; dans les deux
 * cas l'appelant passe au suivant. Un processus toujours vivant après
 * {@link OPENER_SETTLE_MS} est un succès : certains lanceurs restent attachés au
 * navigateur qu'ils viennent d'ouvrir, et attendre leur sortie serait attendre
 * que l'utilisateur ferme sa fenêtre.
 */
function runOpener(
	spawnOpener: OpenExternalDeps["spawnOpener"],
	command: string,
	args: string[],
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (success: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(success);
		};
		let child: ChildProcess;
		try {
			child = spawnOpener(command, args);
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			child.unref?.();
			done(true);
		}, OPENER_SETTLE_MS);
		child.once("error", () => done(false));
		child.once("exit", (code) => done(code === 0));
	});
}

/**
 * Ouvre l'URL, ou lève en disant ce qui a été essayé. Ne rend jamais la main en
 * silence sur un échec : c'est ce silence que l'utilisateur voyait.
 */
export async function openExternalUrl(
	url: string,
	deps: Partial<OpenExternalDeps> = {},
): Promise<void> {
	const { openExternal, linux, spawnOpener } = { ...defaultDeps, ...deps };
	const parsed = parseExternalUrl(url);
	const target = parsed.toString();

	let firstFailure: unknown;
	try {
		await openExternal(target);
		return;
	} catch (error) {
		firstFailure = error;
		if (!linux) throw error;
	}

	const attempted: string[] = [];
	for (const [command, ...args] of LINUX_OPENERS) {
		attempted.push(command);
		if (await runOpener(spawnOpener, command, [...args, target])) return;
	}

	const reason =
		firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
	throw new Error(
		`Unable to open ${target} in a browser (${reason}). Tried: ${attempted.join(", ")}.`,
	);
}
