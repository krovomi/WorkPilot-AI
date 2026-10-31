import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

/**
 * Les lanceurs génériques, sans les navigateurs nommés : un lien `obsidian:`
 * confié à Firefox n'ouvre pas Obsidian, il ouvre un onglet d'erreur — et le
 * processus encore vivant passait pour un succès.
 */
export const LINUX_SCHEME_OPENERS: readonly (readonly string[])[] =
	LINUX_OPENERS.slice(0, 4);

/**
 * PowerShell vu depuis WSL : par le PATH Windows quand l'interop l'y ajoute,
 * sinon par son chemin sous le montage du disque système.
 */
export const WSL_POWERSHELL_CANDIDATES: readonly string[] = [
	"powershell.exe",
	"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
];

/** Au-delà, on considère que le lanceur a rendu la main au navigateur. */
const OPENER_SETTLE_MS = 2500;

export interface OpenExternalDeps {
	openExternal: (url: string) => Promise<void>;
	linux: boolean;
	/** Linux sous WSL : Obsidian est une application Windows. */
	wsl: boolean;
	/** Chemin Linux → chemin que Windows sait ouvrir (`wslpath -w`). */
	toWindowsPath: (linuxPath: string) => string | null;
	spawnOpener: (command: string, args: string[]) => ChildProcess;
}

/** Ce processus est-il un Linux lancé sous WSL (1 ou 2) ? */
export function detectWsl(
	linux = isLinux(),
	env: NodeJS.ProcessEnv = process.env,
	readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): boolean {
	if (!linux) return false;
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
	for (const probe of ["/proc/sys/kernel/osrelease", "/proc/version"]) {
		try {
			if (readText(probe).toLowerCase().includes("microsoft")) return true;
		} catch {
			// sonde absente : on essaie la suivante
		}
	}
	return false;
}

/** `[automount] root` de `/etc/wsl.conf`, sinon `/mnt/`. */
export function readAutomountRoot(
	readText: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string {
	let text: string;
	try {
		text = readText("/etc/wsl.conf");
	} catch {
		return "/mnt/";
	}
	let inAutomount = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const section = /^\[(.+)\]$/.exec(line);
		if (section) {
			inAutomount = section[1].trim().toLowerCase() === "automount";
			continue;
		}
		const entry = /^root\s*=\s*(.*)$/i.exec(line);
		if (inAutomount && entry) {
			const root = entry[1].trim().replace(/^["']|["']$/g, "");
			if (root) return root.endsWith("/") ? root : `${root}/`;
		}
	}
	return "/mnt/";
}

/**
 * Le chemin qu'Obsidian pour Windows comprend, pour un fichier que ce processus
 * WSL voit. `/mnt/c/Users/x/Vault/n.md` devient `C:\Users\x\Vault\n.md` ;
 * un fichier du système de fichiers Linux (`/home/x/.workpilot/…`) devient
 * `\\wsl.localhost\<distro>\home\x\…`. Sans distribution connue, on ne
 * sait pas le nommer : `null`.
 */
export function wslToWindowsPath(
	linuxPath: string,
	automountRoot: string,
	distro: string | undefined,
): string | null {
	if (!linuxPath.startsWith("/")) return linuxPath;
	const root = automountRoot.endsWith("/") ? automountRoot : `${automountRoot}/`;
	if (linuxPath.startsWith(root)) {
		const drive = /^([A-Za-z])(?:\/(.*))?$/.exec(linuxPath.slice(root.length));
		if (drive) {
			const rest = (drive[2] ?? "").replace(/\//g, "\\");
			return `${drive[1].toUpperCase()}:\\${rest}`;
		}
	}
	if (!distro) return null;
	return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, "\\")}`;
}

const defaultDeps: OpenExternalDeps = {
	openExternal: (url) => shell.openExternal(url),
	linux: isLinux(),
	wsl: detectWsl(),
	toWindowsPath: (linuxPath) =>
		wslToWindowsPath(
			linuxPath,
			readAutomountRoot(),
			process.env.WSL_DISTRO_NAME,
		),
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
	const resolved = { ...defaultDeps, ...deps };
	const { openExternal, linux, spawnOpener } = resolved;
	const parsed = parseExternalUrl(url);
	if (parsed.protocol === "obsidian:") return openObsidianUrl(parsed, resolved);
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

/**
 * Réécrit les paramètres `path` et `file` d'un lien Obsidian en chemins
 * Windows. Encodés avec `encodeURIComponent` et non `URLSearchParams`, qui
 * écrirait les espaces en `+` — qu'Obsidian ne décode pas.
 */
function obsidianUrlForWindows(
	parsed: URL,
	toWindowsPath: OpenExternalDeps["toWindowsPath"],
): string {
	const query: string[] = [];
	for (const [key, value] of parsed.searchParams) {
		let next = value;
		if (key === "path" && value.startsWith("/")) {
			const windows = toWindowsPath(value);
			if (!windows) {
				throw new Error(
					`Unable to open ${value} in Obsidian: no Windows path for this WSL file.`,
				);
			}
			next = windows;
		}
		query.push(`${encodeURIComponent(key)}=${encodeURIComponent(next)}`);
	}
	return `obsidian://${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${
		query.length ? `?${query.join("&")}` : ""
	}`;
}

/**
 * Ouvre une note dans Obsidian.
 *
 * Sous WSL, l'application tourne sous Linux mais Obsidian est installé sous
 * Windows : `shell.openExternal` passait le lien à `xdg-open`, qui ne connaît
 * pas le schéma `obsidian:`, puis aux navigateurs Linux — et le chemin de la
 * note, `/home/…` ou `/mnt/c/…`, n'aurait de toute façon rien dit à Obsidian.
 * Le lien est donc réécrit avec le chemin Windows et confié à Windows, qui
 * connaît le gestionnaire du schéma. Le bouton ne faisait rien parce que le
 * rejet était avalé : ici, chaque échec lève avec une raison.
 */
async function openObsidianUrl(
	parsed: URL,
	deps: OpenExternalDeps,
): Promise<void> {
	const hint =
		"Is Obsidian installed, and is the brain folder opened as a vault in it?";

	if (deps.wsl) {
		const target = obsidianUrlForWindows(parsed, deps.toWindowsPath);
		// PowerShell entre apostrophes : une apostrophe s'y double.
		const command = `Start-Process '${target.replace(/'/g, "''")}'`;
		for (const powershell of WSL_POWERSHELL_CANDIDATES) {
			const ok = await runOpener(deps.spawnOpener, powershell, [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				command,
			]);
			if (ok) return;
		}
		throw new Error(`Unable to open ${target} in Obsidian from WSL. ${hint}`);
	}

	const target = parsed.toString();
	let firstFailure: unknown;
	try {
		await deps.openExternal(target);
		return;
	} catch (error) {
		firstFailure = error;
	}
	if (deps.linux) {
		for (const [command, ...args] of LINUX_SCHEME_OPENERS) {
			if (await runOpener(deps.spawnOpener, command, [...args, target])) return;
		}
	}
	const reason =
		firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
	throw new Error(`Unable to open ${target} in Obsidian (${reason}). ${hint}`);
}
