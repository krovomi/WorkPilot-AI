/**
 * architecture-connections — rules for which architecture blocks may connect,
 * and the human-readable relationship label for each valid connection.
 *
 * Goals:
 *  - Only allow *logical* software-architecture edges (e.g. a Worker does not
 *    talk to a Database directly; it goes through a Queue / the Backend).
 *  - Give every valid edge a spoken label ("HTTP/REST", "lit/écrit", …) so the
 *    diagram reads as an architecture, and so the generated spec is precise.
 *
 * Pure + bilingual (fr/en) so it can be unit tested and reused anywhere.
 */

export type Lang = "fr" | "en";

interface Relation {
	en: string;
	fr: string;
}

/**
 * Directed adjacency: RELATIONS[source][target] = relationship label.
 * A pair that is absent is not a valid connection (unless one side is a plain
 * untyped node or a `custom` block — see {@link canConnect}).
 *
 * Deliberately follows the request/data-flow direction, so drawing the arrow
 * the "wrong way" is rejected and teaches the correct architecture.
 */
const RELATIONS: Record<string, Record<string, Relation>> = {
	frontend: {
		gateway: { en: "requests via", fr: "passe par" },
		backend: { en: "HTTP / REST", fr: "HTTP / REST" },
		microservice: { en: "HTTP / REST", fr: "HTTP / REST" },
		auth: { en: "authenticates via", fr: "s'authentifie via" },
		cdn: { en: "loads assets from", fr: "charge les assets depuis" },
		analytics: { en: "sends events to", fr: "envoie les événements à" },
		notification: { en: "receives", fr: "reçoit" },
		thirdparty: { en: "calls", fr: "appelle" },
	},
	mobile: {
		gateway: { en: "requests via", fr: "passe par" },
		backend: { en: "HTTP / REST", fr: "HTTP / REST" },
		microservice: { en: "HTTP / REST", fr: "HTTP / REST" },
		auth: { en: "authenticates via", fr: "s'authentifie via" },
		cdn: { en: "loads assets from", fr: "charge les assets depuis" },
		analytics: { en: "sends events to", fr: "envoie les événements à" },
		notification: { en: "receives", fr: "reçoit" },
		thirdparty: { en: "calls", fr: "appelle" },
		monitoring: { en: "reports to", fr: "remonte vers" },
	},
	desktop: {
		// A thick client can talk directly to the DB (classic 2-tier) OR go
		// through a backend/API (3-tier) — both are legitimate desktop patterns.
		backend: { en: "HTTP / REST", fr: "HTTP / REST" },
		microservice: { en: "HTTP / REST", fr: "HTTP / REST" },
		gateway: { en: "requests via", fr: "passe par" },
		database: { en: "reads / writes", fr: "lit / écrit" },
		auth: { en: "authenticates via", fr: "s'authentifie via" },
		storage: { en: "stores files in", fr: "stocke les fichiers dans" },
		cache: { en: "caches in", fr: "met en cache dans" },
		thirdparty: { en: "calls", fr: "appelle" },
		notification: { en: "receives", fr: "reçoit" },
		monitoring: { en: "reports to", fr: "remonte vers" },
		analytics: { en: "sends events to", fr: "envoie les événements à" },
	},
	gateway: {
		backend: { en: "routes to", fr: "route vers" },
		microservice: { en: "routes to", fr: "route vers" },
		auth: { en: "verifies token via", fr: "vérifie le jeton via" },
	},
	backend: {
		database: { en: "reads / writes", fr: "lit / écrit" },
		cache: { en: "caches in", fr: "met en cache dans" },
		search: { en: "indexes / queries", fr: "indexe / interroge" },
		queue: { en: "publishes to", fr: "publie dans" },
		messagebroker: { en: "publishes to", fr: "publie dans" },
		storage: { en: "stores files in", fr: "stocke les fichiers dans" },
		thirdparty: { en: "calls", fr: "appelle" },
		auth: { en: "validates via", fr: "valide via" },
		notification: { en: "sends via", fr: "envoie via" },
		microservice: { en: "calls", fr: "appelle" },
		monitoring: { en: "reports to", fr: "remonte vers" },
		analytics: { en: "sends events to", fr: "envoie les événements à" },
	},
	microservice: {
		database: { en: "reads / writes", fr: "lit / écrit" },
		cache: { en: "caches in", fr: "met en cache dans" },
		search: { en: "indexes / queries", fr: "indexe / interroge" },
		queue: { en: "publishes to", fr: "publie dans" },
		messagebroker: { en: "publishes to", fr: "publie dans" },
		storage: { en: "stores files in", fr: "stocke les fichiers dans" },
		thirdparty: { en: "calls", fr: "appelle" },
		auth: { en: "validates via", fr: "valide via" },
		notification: { en: "sends via", fr: "envoie via" },
		microservice: { en: "calls", fr: "appelle" },
		monitoring: { en: "reports to", fr: "remonte vers" },
	},
	worker: {
		// Note: a Worker does NOT hit the Database directly — it consumes from a
		// queue/broker and lets the Backend own persistence.
		cache: { en: "uses", fr: "utilise" },
		storage: { en: "stores in", fr: "stocke dans" },
		search: { en: "indexes", fr: "indexe" },
		thirdparty: { en: "calls", fr: "appelle" },
		notification: { en: "sends via", fr: "envoie via" },
		monitoring: { en: "reports to", fr: "remonte vers" },
	},
	queue: {
		worker: { en: "consumed by", fr: "consommée par" },
		backend: { en: "consumed by", fr: "consommée par" },
		microservice: { en: "consumed by", fr: "consommée par" },
	},
	messagebroker: {
		worker: { en: "delivers to", fr: "distribue à" },
		backend: { en: "delivers to", fr: "distribue à" },
		microservice: { en: "delivers to", fr: "distribue à" },
	},
	cdn: {
		frontend: { en: "serves", fr: "sert" },
		storage: { en: "origin", fr: "origine" },
	},
	auth: {
		database: { en: "reads / writes", fr: "lit / écrit" },
	},
};

const GENERIC: Relation = { en: "connects to", fr: "relié à" };

/**
 * What each relationship *means*, as a sentence. The short label above says
 * which protocol or verb; this is the text written between two blocks so a
 * diagram explains itself to someone who did not draw it — and the line the
 * coding agent reads under each connection of the build spec.
 *
 * Keyed by the English label, so two pairs that share a verb share its
 * explanation. `{s}` and `{t}` are the source and target block names.
 * `architecture-connections.test.ts` checks every relation has one.
 */
const EXPLAIN: Record<string, Relation> = {
	"requests via": {
		en: "{s} sends every request through {t}",
		fr: "{s} fait passer toutes ses requêtes par {t}",
	},
	"HTTP / REST": {
		en: "{s} calls the HTTP / REST API exposed by {t}",
		fr: "{s} appelle l'API HTTP / REST exposée par {t}",
	},
	"authenticates via": {
		en: "{s} signs the user in through {t} and keeps the token",
		fr: "{s} connecte l'utilisateur via {t} et conserve son jeton",
	},
	"loads assets from": {
		en: "{s} loads its static files (scripts, styles, images) from {t}",
		fr: "{s} charge ses fichiers statiques (scripts, styles, images) depuis {t}",
	},
	"sends events to": {
		en: "{s} sends its usage events to {t}",
		fr: "{s} envoie ses événements d'usage à {t}",
	},
	receives: {
		en: "{s} receives the notifications pushed by {t}",
		fr: "{s} reçoit les notifications poussées par {t}",
	},
	calls: {
		en: "{s} calls {t} for a capability it does not own",
		fr: "{s} appelle {t} pour une capacité qu'il ne porte pas",
	},
	"reads / writes": {
		en: "{s} reads and writes its data in {t}",
		fr: "{s} lit et écrit ses données dans {t}",
	},
	"stores files in": {
		en: "{s} stores its files in {t}",
		fr: "{s} stocke ses fichiers dans {t}",
	},
	"caches in": {
		en: "{s} keeps frequent reads in {t} to answer faster",
		fr: "{s} garde les lectures fréquentes dans {t} pour répondre plus vite",
	},
	"reports to": {
		en: "{s} sends its logs, metrics and traces to {t}",
		fr: "{s} envoie ses logs, métriques et traces à {t}",
	},
	"routes to": {
		en: "{s} forwards each request to {t}",
		fr: "{s} transmet chaque requête à {t}",
	},
	"verifies token via": {
		en: "{s} checks the token of each request with {t}",
		fr: "{s} vérifie le jeton de chaque requête auprès de {t}",
	},
	"indexes / queries": {
		en: "{s} indexes its content in {t} and queries it to search",
		fr: "{s} indexe son contenu dans {t} et l'interroge pour chercher",
	},
	"publishes to": {
		en: "{s} publishes messages to {t} without waiting for them to be handled",
		fr: "{s} publie des messages dans {t} sans attendre leur traitement",
	},
	"validates via": {
		en: "{s} validates tokens and permissions with {t}",
		fr: "{s} valide les jetons et les droits auprès de {t}",
	},
	"sends via": {
		en: "{s} sends emails, texts or push notifications through {t}",
		fr: "{s} envoie e-mails, SMS ou notifications push via {t}",
	},
	uses: {
		en: "{s} uses {t} to share short-lived state",
		fr: "{s} utilise {t} pour partager un état de courte durée",
	},
	"stores in": {
		en: "{s} stores what it produces in {t}",
		fr: "{s} stocke ce qu'il produit dans {t}",
	},
	indexes: {
		en: "{s} keeps the {t} index up to date",
		fr: "{s} tient l'index de {t} à jour",
	},
	"consumed by": {
		en: "{t} consumes the messages waiting in {s}, one at a time",
		fr: "{t} consomme les messages en attente dans {s}, un par un",
	},
	"delivers to": {
		en: "{s} delivers each published event to {t}",
		fr: "{s} distribue chaque événement publié à {t}",
	},
	serves: {
		en: "{s} serves the static files of {t} close to its users",
		fr: "{s} sert les fichiers statiques de {t} au plus près des utilisateurs",
	},
	origin: {
		en: "{s} fetches from {t} the files it does not have in cache",
		fr: "{s} va chercher dans {t} les fichiers qu'il n'a pas en cache",
	},
	"connects to": {
		en: "{s} exchanges with {t}",
		fr: "{s} échange avec {t}",
	},
};

function pick(rel: Relation, lang: Lang): string {
	return lang === "fr" ? rel.fr : rel.en;
}

/**
 * Whether an edge from `sourceType` to `targetType` is architecturally valid.
 * Untyped nodes (plain flowchart boxes) and `custom` blocks are permissive
 * escape hatches so the canvas stays usable for free-form diagrams.
 */
export function canConnect(
	sourceType: string | undefined,
	targetType: string | undefined,
): boolean {
	if (!sourceType || !targetType) return true;
	if (sourceType === targetType && sourceType !== "microservice") {
		// Two of the same block (except microservice↔microservice) is rarely a
		// meaningful direct edge.
		return sourceType === "custom";
	}
	if (sourceType === "custom" || targetType === "custom") return true;
	return Boolean(RELATIONS[sourceType]?.[targetType]);
}

/**
 * The spoken relationship label for a (source → target) edge, localized.
 * Falls back to a generic label for permissive (custom/untyped) connections.
 */
export function connectionLabel(
	sourceType: string | undefined,
	targetType: string | undefined,
	lang: Lang = "en",
): string {
	if (sourceType && targetType) {
		const rel = RELATIONS[sourceType]?.[targetType];
		if (rel) return pick(rel, lang);
	}
	return pick(GENERIC, lang);
}

/**
 * The sentence written between two blocks: what the source does with the
 * target, with their current names in it. Used when the person has not
 * written their own — so renaming a block renames it in the explanation too,
 * and only a text they typed themselves stays fixed.
 */
export function explainConnection(
	sourceType: string | undefined,
	targetType: string | undefined,
	sourceName: string,
	targetName: string,
	lang: Lang = "en",
): string {
	const rel =
		(sourceType && targetType && RELATIONS[sourceType]?.[targetType]) || GENERIC;
	const template = EXPLAIN[rel.en] ?? EXPLAIN[GENERIC.en];
	return pick(template, lang)
		.replaceAll("{s}", sourceName)
		.replaceAll("{t}", targetName);
}

/** Every relation label in use, for the test that pins one explanation each. */
export function relationLabels(): string[] {
	const labels = new Set<string>([GENERIC.en]);
	for (const targets of Object.values(RELATIONS)) {
		for (const rel of Object.values(targets)) labels.add(rel.en);
	}
	return [...labels];
}

/** Whether a relation label has a written explanation. */
export function hasExplanation(label: string): boolean {
	return label in EXPLAIN;
}
