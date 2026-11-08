/**
 * architecture-lint — rules that only show on the whole diagram, once each
 * link is fine on its own.
 *
 * A pair check cannot see that two microservices write the same database,
 * that services call each other in a circle, that a client walks around the
 * gateway, or that a queue has nobody reading it. These are the classic
 * application-architecture smells (database per service, no synchronous
 * cycles / distributed monolith, single entry point, every message consumed,
 * every store owned), plus the stack mismatches of `stack-rules.ts` and the
 * links forced past the rules.
 *
 * The canvas lists them in its coherence panel; the build spec hands them to
 * the coding agent. Pure and bilingual; `architecture-lint.test.ts`.
 */

import { canConnect, type Lang } from "./architecture-connections";
import { stackWarnings } from "./stack-rules";

export interface LintNode {
	id: string;
	data?: { type?: string; label?: string; framework?: string };
}

export interface LintEdge {
	id: string;
	source: string;
	target: string;
	data?: { label?: string; forced?: boolean };
}

export type Severity = "warning" | "info";

export interface Finding {
	/** Stable id: rule and the elements it is about. */
	id: string;
	rule: string;
	severity: Severity;
	message: string;
	nodeIds: string[];
	edgeIds: string[];
}

interface Text {
	en: string;
	fr: string;
}

const MESSAGES: Record<string, Text> = {
	sharedDatabase: {
		en: "{list} share the database {a}: each microservice should own its data (database per service) and expose it through its API or events.",
		fr: "{list} partagent la base {a} : chaque microservice doit posséder ses données (une base par service) et les exposer par son API ou des événements.",
	},
	syncCycle: {
		en: "Synchronous calls go round in a circle ({list}): one failure blocks them all (distributed monolith). Break the cycle with an event or a queue.",
		fr: "Les appels synchrones tournent en rond ({list}) : une panne les bloque tous (monolithe distribué). Cassez le cycle par un événement ou une file.",
	},
	gatewayBypass: {
		en: "{a} calls {b} directly although {c} is the entry point: go through the gateway so auth, rate limits and routing apply.",
		fr: "{a} appelle {b} en direct alors que {c} est le point d'entrée : passez par la gateway pour que l'authentification, les quotas et le routage s'appliquent.",
	},
	clientManyServices: {
		en: "{a} calls {n} services directly: an API Gateway or a BFF (backend for frontend) would give it one entry point.",
		fr: "{a} appelle {n} services en direct : une API Gateway ou un BFF (backend for frontend) lui donnerait un seul point d'entrée.",
	},
	noConsumer: {
		en: "Nobody consumes the messages of {a}: link it to the Worker, Backend or Microservice that handles them.",
		fr: "Personne ne consomme les messages de {a} : reliez-la au Worker, Backend ou Microservice qui les traite.",
	},
	noProducer: {
		en: "Nothing publishes to {a}: link the service that produces its messages.",
		fr: "Rien ne publie dans {a} : reliez le service qui produit ses messages.",
	},
	idleWorker: {
		en: "Nothing triggers {a}: link the queue or service that hands it work, or say in its description that it runs on a schedule.",
		fr: "Rien ne déclenche {a} : reliez la file ou le service qui lui confie le travail, ou précisez dans sa description qu'il est planifié.",
	},
	unownedStore: {
		en: "No service reads or writes {a}: link the block that owns this data.",
		fr: "Aucun service ne lit ni n'écrit {a} : reliez le bloc qui possède ces données.",
	},
	unusedAuth: {
		en: "Nobody signs in through {a}: link the clients that authenticate and the services that check tokens.",
		fr: "Personne ne s'authentifie via {a} : reliez les clients qui s'y connectent et les services qui vérifient les jetons.",
	},
	desktopBypass: {
		en: "{a} writes {b} directly and also calls {c}: the backend's business rules are skipped on the direct path. Keep one of the two.",
		fr: "{a} écrit dans {b} en direct et appelle aussi {c} : les règles métier du backend sont contournées par le chemin direct. Gardez l'un des deux.",
	},
	orphan: {
		en: "{a} is linked to nothing.",
		fr: "{a} n'est relié à rien.",
	},
	forced: {
		en: "{a} → {b} was linked outside the architecture rules: check that it is intended.",
		fr: "{a} → {b} a été relié hors des règles d'architecture : vérifiez que c'est voulu.",
	},
	stack: {
		en: "{a} → {b}: {why}",
		fr: "{a} → {b} : {why}",
	},
};

const SERVICES = new Set(["backend", "microservice"]);
const CLIENTS = new Set(["frontend", "mobile", "desktop"]);
const STORES = new Set(["database", "cache", "search", "storage"]);
const MESSAGING = new Set(["queue", "messagebroker"]);

function fill(text: string, vars: Record<string, string | number>): string {
	return text.replace(/\{(\w+)\}/g, (m, k: string) =>
		k in vars ? String(vars[k]) : m,
	);
}

/**
 * Every whole-diagram finding, warnings first. `resolveStack` turns a stack
 * id into its display name for the stack warnings.
 */
export function lintArchitecture(
	nodes: LintNode[],
	edges: LintEdge[],
	lang: Lang,
	resolveStack: (stack: string) => string = (k) => k,
): Finding[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const live = edges.filter(
		(e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target),
	);
	const typeOf = (id: string) => byId.get(id)?.data?.type;
	const quote = (id: string) => {
		const label = byId.get(id)?.data?.label?.trim() || id;
		return lang === "fr" ? `« ${label} »` : `“${label}”`;
	};
	const out = (e: LintNode) => live.filter((x) => x.source === e.id);
	const into = (e: LintNode) => live.filter((x) => x.target === e.id);
	const findings: Finding[] = [];
	const push = (
		rule: string,
		severity: Severity,
		vars: Record<string, string | number>,
		nodeIds: string[],
		edgeIds: string[] = [],
	) =>
		findings.push({
			id: `${rule}:${[...nodeIds, ...edgeIds].join(",")}`,
			rule,
			severity,
			message: fill(MESSAGES[rule][lang], vars),
			nodeIds,
			edgeIds,
		});
	const list = (ids: string[]) => ids.map(quote).join(", ");

	// ── Per link: stacks, forced links ──────────────────────────────────
	for (const e of live) {
		const s = byId.get(e.source)?.data ?? {};
		const t = byId.get(e.target)?.data ?? {};
		for (const why of stackWarnings(s, t, lang, resolveStack)) {
			push("stack", "warning", { a: quote(e.source), b: quote(e.target), why }, [], [e.id]);
		}
		if (e.data?.forced && !canConnect(s.type, t.type)) {
			push("forced", "info", { a: quote(e.source), b: quote(e.target) }, [], [e.id]);
		}
	}

	// ── Database per service ────────────────────────────────────────────
	for (const n of nodes) {
		if (n.data?.type !== "database") continue;
		const owners = [
			...new Set(
				into(n)
					.filter((e) => typeOf(e.source) === "microservice")
					.map((e) => e.source),
			),
		];
		if (owners.length >= 2) {
			push("sharedDatabase", "warning", { list: list(owners), a: quote(n.id) }, [n.id, ...owners]);
		}
	}

	// ── No synchronous cycle between services ───────────────────────────
	const callEdges = live.filter(
		(e) => SERVICES.has(typeOf(e.source) ?? "") && SERVICES.has(typeOf(e.target) ?? ""),
	);
	const seen = new Set<string>();
	const graph = new Map<string, string[]>();
	for (const e of callEdges) {
		graph.set(e.source, [...(graph.get(e.source) ?? []), e.target]);
	}
	const visit = (start: string, at: string, path: string[]): void => {
		for (const next of graph.get(at) ?? []) {
			if (next === start) {
				const key = [...path].sort().join(",");
				if (!seen.has(key)) {
					seen.add(key);
					push("syncCycle", "warning", { list: [...path, start].map(quote).join(" → ") }, [...path]);
				}
			} else if (!path.includes(next) && next > start) {
				visit(start, next, [...path, next]);
			}
		}
	};
	for (const id of [...graph.keys()].sort()) visit(id, id, [id]);

	// ── One entry point for clients ─────────────────────────────────────
	const gateways = nodes.filter((n) => n.data?.type === "gateway");
	for (const n of nodes) {
		if (!CLIENTS.has(n.data?.type ?? "")) continue;
		const direct = out(n).filter((e) => SERVICES.has(typeOf(e.target) ?? ""));
		if (gateways.length > 0) {
			for (const e of direct) {
				push(
					"gatewayBypass",
					"warning",
					{ a: quote(n.id), b: quote(e.target), c: quote(gateways[0].id) },
					[n.id, e.target],
					[e.id],
				);
			}
		} else if (direct.length >= 3) {
			push("clientManyServices", "info", { a: quote(n.id), n: direct.length }, [n.id]);
		}
		if (n.data?.type === "desktop") {
			const db = out(n).find((e) => typeOf(e.target) === "database");
			if (db && direct.length > 0) {
				push(
					"desktopBypass",
					"warning",
					{ a: quote(n.id), b: quote(db.target), c: quote(direct[0].target) },
					[n.id],
					[db.id],
				);
			}
		}
	}

	// ── Every message consumed, every store owned, every block used ─────
	for (const n of nodes) {
		const type = n.data?.type ?? "";
		const ins = into(n);
		const outs = out(n);
		if (MESSAGING.has(type)) {
			if (ins.length > 0 && outs.length === 0)
				push("noConsumer", "warning", { a: quote(n.id) }, [n.id]);
			if (outs.length > 0 && ins.length === 0)
				push("noProducer", "warning", { a: quote(n.id) }, [n.id]);
		}
		if (type === "worker" && ins.length === 0 && outs.length > 0)
			push("idleWorker", "info", { a: quote(n.id) }, [n.id]);
		if (STORES.has(type) && ins.length === 0 && outs.length > 0)
			push("unownedStore", "warning", { a: quote(n.id) }, [n.id]);
		if (type === "auth" && ins.length === 0 && outs.length > 0)
			push("unusedAuth", "warning", { a: quote(n.id) }, [n.id]);
		if (nodes.length > 1 && ins.length === 0 && outs.length === 0)
			push("orphan", "info", { a: quote(n.id) }, [n.id]);
	}

	return findings.sort(
		(a, b) => Number(a.severity === "info") - Number(b.severity === "info"),
	);
}
