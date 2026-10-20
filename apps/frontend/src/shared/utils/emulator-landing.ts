/**
 * Où ouvrir l'aperçu d'une tâche.
 *
 * L'émulateur ouvrait la racine du serveur, ce qui est la bonne réponse pour un
 * site et la mauvaise pour tout le reste : une Web API .NET répond 404 sur `/`,
 * et la page que la tâche vient d'écrire est trois segments plus loin. Le diff
 * de la tâche dit précisément quelle route a été touchée — c'est une preuve
 * mesurée, pas une convention devinée — et ce module est le seul endroit qui la
 * lit.
 *
 * Rien ici n'appelle de modèle ni de réseau : des chemins et des lignes
 * ajoutées, donc l'UI peut poser la question avant d'avoir démarré quoi que ce
 * soit et n'en payer que le coût d'une expression régulière.
 */

/** Un fichier du diff de la tâche, tel que `getWorktreeDiff` le rend. */
export interface EmulatorChangedFile {
	path: string;
	patch?: string;
}

/** D'où vient la réponse — affiché à l'utilisateur à côté de la route. */
export type LandingSource =
	| "route-declaration"
	| "file-route"
	| "launch-profile"
	| "api-docs";

export interface LandingGuess {
	/** Chemin côté serveur, toujours préfixé par « / » et sans « / » final. */
	path: string;
	source: LandingSource;
	/** Le fichier qui porte la preuve, quand il y en a un. */
	file?: string;
}

/** Les segments qu'une route déclare mais qu'une URL ne peut pas porter. */
const DYNAMIC_SEGMENT = /^(?:[:$*]|\{.*\}$|\[.*\]$|<.*>$|\*\*?$)/;

/** Un token ASP.NET à substituer (`[controller]`) plutôt qu'à tronquer. */
const ASPNET_TOKEN = /^\[(controller|action|area)\]$/i;

interface RouteMatcher {
	/** Extensions auxquelles le motif s'applique. */
	extensions: readonly string[];
	/** Capture 1 = la route brute. */
	pattern: RegExp;
	/**
	 * Motifs trop courants pour être lus n'importe où (`path:` est une clé de
	 * configuration autant qu'une route) : réservés aux fichiers dont le nom dit
	 * qu'ils déclarent des routes.
	 */
	routeFileOnly?: boolean;
}

const DOTNET = [".cs"] as const;
const WEB = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const PYTHON = [".py"] as const;
const JVM = [".java", ".kt"] as const;

const ROUTE_MATCHERS: readonly RouteMatcher[] = [
	// ASP.NET Core — attributs de contrôleur puis Minimal API.
	{ extensions: DOTNET, pattern: /\[\s*Route\s*\(\s*"([^"]*)"/ },
	{
		extensions: DOTNET,
		pattern: /\bMap(?:Get|Post|Put|Patch|Delete|Group)\s*\(\s*"([^"]*)"/,
	},
	// Blazor / Razor components.
	{ extensions: [".razor", ".cshtml"], pattern: /@page\s+"([^"]*)"/ },
	// NestJS.
	{ extensions: WEB, pattern: /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/ },
	// Express / Fastify / Koa — la route est ancrée sur « / » pour éviter
	// `app.use(cors())` et les middlewares nommés.
	{
		extensions: WEB,
		pattern:
			/\b(?:app|router|server|api|fastify)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*['"`](\/[^'"`]*)['"`]/,
	},
	// React Router en JSX.
	{ extensions: WEB, pattern: /<Route\b[^>]*\bpath\s*=\s*['"{]+([^'"}]*)['"}]/ },
	// React Router / Angular en objet — seulement dans un fichier de routes.
	{
		extensions: WEB,
		pattern: /\bpath\s*:\s*['"`]([^'"`]*)['"`]/,
		routeFileOnly: true,
	},
	// FastAPI / Flask / Blueprints.
	{
		extensions: PYTHON,
		pattern:
			/@(?:app|router|api|bp|blueprint)\s*\.\s*(?:get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]*)['"]/,
	},
	// Django.
	{
		extensions: PYTHON,
		pattern: /\b(?:re_path|path)\s*\(\s*r?['"]([^'"]*)['"]/,
		routeFileOnly: true,
	},
	// Spring.
	{
		extensions: JVM,
		pattern:
			/@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:(?:path|value)\s*=\s*)?['"]([^'"]*)['"]/,
	},
];

/** Un fichier dont le nom annonce qu'il déclare des routes. */
function isRouteFile(filePath: string): boolean {
	const name = filePath.toLowerCase().split(/[\\/]/).pop() ?? "";
	return (
		name.includes("route") ||
		name.includes("router") ||
		name.includes("urls.") ||
		name.includes("-routing.")
	);
}

function extensionOf(filePath: string): string {
	const name = filePath.toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot);
}

/** Les lignes qu'un patch ajoute, sans leur « + ». */
function addedLines(patch: string | undefined): string[] {
	if (!patch) return [];
	const lines: string[] = [];
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) lines.push(line.slice(1));
	}
	return lines;
}

/**
 * Le nom du contrôleur derrière `[controller]` : d'abord la classe que le patch
 * déclare, sinon le nom du fichier — `DocumentsController.cs` est une
 * convention qu'ASP.NET impose, pas une supposition.
 */
function controllerName(filePath: string, lines: readonly string[]): string | null {
	for (const line of lines) {
		const match = line.match(/\bclass\s+([A-Za-z_]\w*)Controller\b/);
		if (match) return match[1].toLowerCase();
	}
	const base = (filePath.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
	const match = base.match(/^(.+)Controller$/);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Coupe la route au premier segment qu'une URL ne peut pas porter. `api/users/{id}`
 * devient `/api/users` : la liste existe presque toujours, l'identifiant non.
 * Rend `null` quand il ne reste rien de statique.
 */
function toStaticPath(
	route: string,
	context: { filePath: string; lines: readonly string[] },
): string | null {
	const trimmed = route.trim();
	if (!trimmed) return null;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

	const kept: string[] = [];
	for (const raw of trimmed.split("/")) {
		const segment = raw.trim();
		if (!segment) continue;
		const token = segment.match(ASPNET_TOKEN);
		if (token) {
			if (token[1].toLowerCase() !== "controller") break;
			const name = controllerName(context.filePath, context.lines);
			if (!name) break;
			kept.push(name);
			continue;
		}
		if (DYNAMIC_SEGMENT.test(segment)) break;
		// Une contrainte ASP.NET (`id:int`) ou un paramètre au milieu du segment.
		if (/[{}<>[\]]/.test(segment) || segment.includes(":")) break;
		kept.push(segment);
	}
	if (kept.length === 0) return null;
	return `/${kept.join("/")}`;
}

/** Les conventions de nommage qui font d'un fichier une page. */
const FILE_ROUTE_PATTERNS: readonly {
	pattern: RegExp;
	/** Remix encode la hiérarchie dans le nom : `documents.new.tsx`. */
	dotted?: boolean;
}[] = [
	{ pattern: /(?:^|\/)app\/(.*)\/(?:page|route)\.[jt]sx?$/ },
	{ pattern: /(?:^|\/)app\/routes\/(.+)\.[jt]sx?$/, dotted: true },
	{ pattern: /(?:^|\/)src\/routes\/(.*)\/\+page\.(?:svelte|[jt]s)$/ },
	{ pattern: /(?:^|\/)pages\/(.+)\.(?:[jt]sx?|vue)$/ },
];

/**
 * La route qu'un chemin de fichier déclare par convention (Next, Nuxt, Remix,
 * SvelteKit). Rend `null` dès qu'un segment est dynamique : « /users/[id] » n'est
 * pas une adresse, et inventer l'identifiant serait pire que ne rien proposer.
 */
export function routeFromFilePath(filePath: string): string | null {
	const normalized = filePath.replaceAll("\\", "/");
	for (const { pattern, dotted } of FILE_ROUTE_PATTERNS) {
		const match = normalized.match(pattern);
		if (!match) continue;
		const raw = dotted ? match[1].replaceAll(".", "/") : match[1];
		const kept: string[] = [];
		for (const segment of raw.split("/")) {
			if (!segment) continue;
			// Groupes de routes et fichiers de layout : invisibles dans l'URL.
			if (/^\(.*\)$/.test(segment)) continue;
			if (segment === "index" || segment.startsWith("_")) continue;
			if (DYNAMIC_SEGMENT.test(segment) || segment.startsWith("[")) break;
			kept.push(segment);
		}
		return kept.length === 0 ? "/" : `/${kept.join("/")}`;
	}
	return null;
}

const SOURCE_RANK: Record<LandingSource, number> = {
	"route-declaration": 0,
	"file-route": 1,
	"launch-profile": 2,
	"api-docs": 3,
};

/** La page d'accueil que le framework expose quand le diff ne dit rien. */
function apiDocsPath(framework: string | undefined): string | null {
	const key = (framework ?? "").toLowerCase();
	if (!key) return null;
	if (key.includes("dotnet") || key.includes("aspnet")) return "/swagger";
	if (key.includes("fastapi")) return "/docs";
	if (key.includes("nest")) return "/api";
	return null;
}

function segmentCount(path: string): number {
	return path.split("/").filter(Boolean).length;
}

/**
 * Toutes les adresses que cette tâche rend plausibles, la plus probable d'abord.
 *
 * L'ordre est celui de la force de la preuve : une route que le diff déclare,
 * puis une page que le diff crée, puis le profil de lancement du projet, puis la
 * documentation d'API du framework. À preuve égale, la route la plus courte
 * passe devant — c'est celle dont on peut atteindre les autres.
 */
export function deriveLandingCandidates(
	files: readonly EmulatorChangedFile[],
	options: { framework?: string; launchPath?: string } = {},
): LandingGuess[] {
	const seen = new Map<string, LandingGuess>();
	const add = (guess: LandingGuess) => {
		const existing = seen.get(guess.path);
		if (!existing || SOURCE_RANK[guess.source] < SOURCE_RANK[existing.source]) {
			seen.set(guess.path, guess);
		}
	};

	for (const file of files) {
		if (!file?.path) continue;
		const extension = extensionOf(file.path);
		const lines = addedLines(file.patch);
		if (lines.length > 0) {
			const routeFile = isRouteFile(file.path);
			for (const matcher of ROUTE_MATCHERS) {
				if (!matcher.extensions.includes(extension)) continue;
				if (matcher.routeFileOnly && !routeFile) continue;
				for (const line of lines) {
					const match = line.match(matcher.pattern);
					if (!match) continue;
					const path = toStaticPath(match[1], { filePath: file.path, lines });
					if (path) add({ path, source: "route-declaration", file: file.path });
				}
			}
		}
		const fileRoute = routeFromFilePath(file.path);
		if (fileRoute) add({ path: fileRoute, source: "file-route", file: file.path });
	}

	const launchPath = normalizeLandingPath(options.launchPath);
	if (launchPath && launchPath !== "/") {
		add({ path: launchPath, source: "launch-profile" });
	}
	const docs = apiDocsPath(options.framework);
	if (docs) add({ path: docs, source: "api-docs" });

	return [...seen.values()].sort((a, b) => {
		const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
		if (rank !== 0) return rank;
		const depth = segmentCount(a.path) - segmentCount(b.path);
		if (depth !== 0) return depth;
		return a.path.localeCompare(b.path);
	});
}

/** La meilleure adresse, ou `null` quand la tâche n'en suggère aucune. */
export function deriveLandingPath(
	files: readonly EmulatorChangedFile[],
	options: { framework?: string; launchPath?: string } = {},
): LandingGuess | null {
	return deriveLandingCandidates(files, options)[0] ?? null;
}

/** Un chemin utilisable dans une URL : « / » en tête, jamais en queue. */
export function normalizeLandingPath(value: string | undefined | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (withSlash === "/") return "/";
	return withSlash.replace(/\/+$/, "") || "/";
}

/**
 * Colle un chemin sur l'origine du serveur. Le chemin l'emporte sur celui de
 * l'URL de base : `http://localhost:5000/` + `/swagger` reste une seule adresse.
 */
export function buildLandingUrl(baseUrl: string, path: string | null | undefined): string {
	const normalized = normalizeLandingPath(path);
	if (!normalized || normalized === "/") return baseUrl;
	try {
		return new URL(normalized, baseUrl).toString();
	} catch {
		return baseUrl;
	}
}

/**
 * Ce que l'utilisateur vient de taper dans la barre d'adresse, résolu contre le
 * serveur de l'émulateur.
 *
 * Le défaut est *relatif au serveur* : dans cette barre on tape « /swagger »
 * ou « swagger » cent fois pour une fois où l'on tape un hôte, et résoudre
 * « swagger » en `http://swagger` serait une navigation vers l'extérieur
 * déguisée en faute de frappe. Un hôte n'est reconnu que quand il se nomme —
 * un point, un port, ou `localhost`.
 *
 * Rend `null` quand l'entrée ne donne aucune adresse http(s) : un `file://` ou
 * un `javascript:` chargé dans l'aperçu serait une navigation que personne n'a
 * demandée.
 */
export function resolveAddressInput(input: string, baseUrl: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	// Un « : » suivi d'un chiffre est un port, pas un schéma : sans cette garde,
	// `localhost:5000` se lit comme le schéma « localhost » et l'entrée la plus
	// courante de cette barre est refusée.
	const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):(?!\d)/i);
	if (scheme) {
		const protocol = `${scheme[1].toLowerCase()}:`;
		if (protocol !== "http:" && protocol !== "https:") return null;
		try {
			return new URL(trimmed).toString();
		} catch {
			return null;
		}
	}

	const looksLikeHost =
		!trimmed.startsWith("/") &&
		/^(?:localhost|\[[^\]]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(trimmed);

	try {
		return new URL(looksLikeHost ? `http://${trimmed}` : trimmed, baseUrl).toString();
	} catch {
		return null;
	}
}

/**
 * Une adresse que l'aperçu peut afficher et que le navigateur du système peut
 * ouvrir.
 *
 * Un `<webview>` en annonce d'autres que celles qu'on lui a demandées :
 * `about:blank` avant la première navigation, et surtout
 * `chrome-error://chromewebdata/` dès qu'une page n'a pas répondu — ce qui est
 * le cas courant ici, puisqu'une Web API répond 404 sur la racine. Suivre ces
 * adresses met dans la barre, puis dans « Ouvrir dans le navigateur », une
 * valeur que personne ne peut ouvrir : le bouton ne pouvait alors que refuser.
 */
export function isBrowsableUrl(value: string | null | undefined): value is string {
	if (!value) return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Deux écritures de la même adresse.
 *
 * Un serveur normalise ce qu'on lui demande : `http://localhost:5000` revient
 * du `<webview>` en `http://localhost:5000/`. Comparer les chaînes ferait lire
 * le premier chargement comme une navigation vers ailleurs — et ce qui en
 * dépend, ici, c'est de savoir si l'utilisateur a choisi la page ou si l'aperçu
 * l'a ouverte tout seul.
 */
export function sameAddress(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return a === b;
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}
