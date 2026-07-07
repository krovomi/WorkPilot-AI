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
