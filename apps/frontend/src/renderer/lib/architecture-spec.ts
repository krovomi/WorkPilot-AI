/**
 * architecture-spec — turn a visual canvas diagram (nodes + edges) into a
 * structured, agent-ready build specification, localized to the user's language.
 *
 * This is the bridge between the no-code Canvas and WorkPilot's agentic build
 * pipeline: the returned `{ title, description }` is fed to `createTask`, and the
 * coder agents scaffold the real, production-ready project from it.
 *
 * Pure and framework-agnostic (no React/ReactFlow imports) so it can be unit
 * tested and reused from anywhere.
 */

import type { Lang } from "./architecture-connections";

export interface DiagramNodeInput {
	id: string;
	data?: {
		label?: string;
		type?: string;
		framework?: string;
	};
}

export interface DiagramEdgeInput {
	source: string;
	target: string;
	data?: { label?: string };
}

export type DiagramKind = "flowchart" | "architecture" | "mockup" | string;

export interface ArchitectureSpec {
	title: string;
	description: string;
}

/** Types that imply an HTTP/REST backend surface. */
const HTTP_BACKEND_TYPES = new Set([
	"backend",
	"api",
	"microservice",
	"gateway",
]);

/** Human-readable role for each palette block type, per language. */
const ROLE_BY_TYPE: Record<Lang, Record<string, string>> = {
	en: {
		frontend: "Frontend UI",
		desktop: "Desktop application",
		backend: "Backend service",
		database: "Database",
		api: "API layer",
		worker: "Background worker",
		microservice: "Microservice",
		gateway: "API gateway",
		cache: "Cache",
		search: "Search engine",
		queue: "Message queue",
		storage: "Object storage",
		messagebroker: "Message broker",
		cdn: "CDN",
		monitoring: "Monitoring",
		analytics: "Analytics",
		auth: "Authentication",
		thirdparty: "Third-party API",
		notification: "Notifications",
		custom: "Custom component",
	},
	fr: {
		frontend: "UI Frontend",
		desktop: "Application desktop",
		backend: "Service backend",
		database: "Base de données",
		api: "Couche API",
		worker: "Worker (tâche de fond)",
		microservice: "Microservice",
		gateway: "Passerelle API",
		cache: "Cache",
		search: "Moteur de recherche",
		queue: "File de messages",
		storage: "Stockage d'objets",
		messagebroker: "Bus de messages",
		cdn: "CDN",
		monitoring: "Supervision",
		analytics: "Analytique",
		auth: "Authentification",
		thirdparty: "API tierce",
		notification: "Notifications",
		custom: "Composant personnalisé",
	},
};

interface SpecStrings {
	componentFallback: (id: string) => string;
	heading: (kind: string) => string;
	intro: string;
	components: string;
	colComponent: string;
	colRole: string;
	colTech: string;
	connections: string;
	noConnections: string;
	requirements: string;
	kindFlowchart: string;
	kindArchitecture: string;
	kindMockup: string;
	titleWebApi: string;
	titleFrontend: string;
	titleDesktop: string;
	titleGeneric: string;
	titleVerb: (noun: string, stacks: string) => string;
	reqBase1: string;
	reqBase2: string;
	reqHttp1: string;
	reqHttp2: string;
	reqHttp3: string;
	reqFeBe: string;
	reqFeOnly: string;
	reqDesktop: string;
	reqDb: string;
	reqAuth: string;
	reqReadme: string;
	reqFlows: string;
}

const STRINGS: Record<Lang, SpecStrings> = {
	en: {
		componentFallback: (id) => `Component ${id}`,
		heading: (kind) => `Scaffold from visual architecture (${kind})`,
		intro:
			"Scaffold the following architecture, designed visually in the WorkPilot canvas, into a working project.",
		components: "Components",
		colComponent: "Component",
		colRole: "Role",
		colTech: "Technology",
		connections: "Connections",
		noConnections: "_No explicit connections were drawn._",
		requirements: "Requirements",
		kindFlowchart: "flowchart",
		kindArchitecture: "architecture diagram",
		kindMockup: "UI mockup",
		titleWebApi: "Web API architecture",
		titleFrontend: "Frontend architecture",
		titleDesktop: "Desktop application architecture",
		titleGeneric: "Architecture",
		titleVerb: (noun, stacks) => `Scaffold ${noun}${stacks}`,
		reqBase1:
			"Generate a **complete, production-ready, deployable** project — no placeholders, stubs, or `TODO`s. All code must compile/run.",
		reqBase2:
			"Use the technology stated for each component. If a component has no stack, choose a sensible, popular default and state it in the README.",
		reqHttp1:
			"The backend must expose a **RESTful HTTP API** with clear resource routes and appropriate status codes.",
		reqHttp2:
			'Include a **health/test endpoint** `GET /health` that returns `200 OK` with a JSON body like `{ "status": "ok" }`, usable to verify the deployment.',
		reqHttp3:
			"Provide a **Dockerfile** (and `docker-compose.yml` if multiple services) plus clear local-run and deployment instructions.",
		reqFeBe:
			"Wire the frontend to the backend API (typed client/service layer, configurable base URL via env var).",
		reqFeOnly:
			"Provide a runnable frontend app with a dev server and build script.",
		reqDesktop:
			"Package the desktop client as a distributable app (installer / MSI / setup) for the stated framework and platform; include build, run and packaging instructions.",
		reqDb:
			"Include the database schema and migrations; read connection settings from environment variables (no hard-coded secrets).",
		reqAuth:
			"Implement the authentication component and protect the relevant routes.",
		reqReadme:
			"Add a top-level **README.md** documenting architecture, how to run locally, how to test the health endpoint, and how to deploy.",
		reqFlows:
			"Respect the connections below as dependencies / data flows between components.",
	},
	fr: {
		componentFallback: (id) => `Composant ${id}`,
		heading: (kind) => `Scaffolding depuis l'architecture visuelle (${kind})`,
		intro:
			"Générer le projet correspondant à l'architecture ci-dessous, conçue visuellement dans le canvas WorkPilot.",
		components: "Composants",
		colComponent: "Composant",
		colRole: "Rôle",
		colTech: "Technologie",
		connections: "Connexions",
		noConnections: "_Aucune connexion explicite n'a été dessinée._",
		requirements: "Exigences",
		kindFlowchart: "organigramme",
		kindArchitecture: "diagramme d'architecture",
		kindMockup: "maquette UI",
		titleWebApi: "architecture Web API",
		titleFrontend: "architecture Frontend",
		titleDesktop: "architecture d'application desktop",
		titleGeneric: "architecture",
		titleVerb: (noun, stacks) => `Générer l'${noun}${stacks}`,
		reqBase1:
			"Générer un projet **complet, prêt pour la production et déployable** — sans placeholder, stub ni `TODO`. Tout le code doit compiler / s'exécuter.",
		reqBase2:
			"Utiliser la technologie indiquée pour chaque composant. Si un composant n'a pas de stack, choisir une valeur par défaut répandue et l'indiquer dans le README.",
		reqHttp1:
			"Le backend doit exposer une **API HTTP RESTful** avec des routes de ressources claires et des codes de statut appropriés.",
		reqHttp2:
			'Inclure un **endpoint de test / santé** `GET /health` qui renvoie `200 OK` avec un corps JSON du type `{ "status": "ok" }`, permettant de vérifier le déploiement.',
		reqHttp3:
			"Fournir un **Dockerfile** (et un `docker-compose.yml` s'il y a plusieurs services) ainsi que des instructions claires d'exécution locale et de déploiement.",
		reqFeBe:
			"Câbler le frontend à l'API backend (couche client/service typée, URL de base configurable via variable d'environnement).",
		reqFeOnly:
			"Fournir une application frontend exécutable avec un serveur de dev et un script de build.",
		reqDesktop:
			"Empaqueter le client lourd en application distribuable (installeur / MSI / setup) pour le framework et la plateforme indiqués ; inclure les instructions de build, d'exécution et de packaging.",
		reqDb:
			"Inclure le schéma de base de données et les migrations ; lire la configuration de connexion depuis des variables d'environnement (aucun secret en dur).",
		reqAuth:
			"Implémenter le composant d'authentification et protéger les routes concernées.",
		reqReadme:
			"Ajouter un **README.md** à la racine documentant l'architecture, l'exécution locale, le test de l'endpoint de santé et le déploiement.",
		reqFlows:
			"Respecter les connexions ci-dessous comme dépendances / flux de données entre composants.",
	},
};

/**
 * Drop edges whose endpoints don't both exist in `nodes`. The canvas can leave
 * dangling edges behind after a node is deleted (e.g. `edge-1-6` with no node
 * `6`), which would otherwise mislead the code generator.
 */
export function sanitizeEdges<T extends DiagramEdgeInput>(
	nodes: DiagramNodeInput[],
	edges: T[],
): T[] {
	const ids = new Set(nodes.map((n) => n.id));
	return edges.filter(
		(e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target),
	);
}

function nodeName(node: DiagramNodeInput, s: SpecStrings): string {
	const label = node.data?.label?.trim();
	return label && label.length > 0 ? label : s.componentFallback(node.id);
}

function roleFor(type: string | undefined, lang: Lang): string {
	if (!type) return lang === "fr" ? "Composant" : "Component";
	return (
		ROLE_BY_TYPE[lang][type] ??
		`${type.charAt(0).toUpperCase()}${type.slice(1)}`
	);
}

function kindLabel(kind: DiagramKind, s: SpecStrings): string {
	if (kind === "architecture") return s.kindArchitecture;
	if (kind === "mockup") return s.kindMockup;
	return s.kindFlowchart;
}

/**
 * Build the agent-ready spec. The requirements section is tailored to the
 * components present so the generated project is production-ready and
 * deployable, and — for any HTTP backend — exposes a health/test endpoint.
 */
export function buildArchitectureSpec(
	nodes: DiagramNodeInput[],
	edges: DiagramEdgeInput[],
	diagramType: DiagramKind = "flowchart",
	lang: Lang = "en",
): ArchitectureSpec {
	const s = STRINGS[lang];
	const cleanEdges = sanitizeEdges(nodes, edges);
	const byId = new Map(nodes.map((n) => [n.id, n]));

	const types = new Set(
		nodes.map((n) => n.data?.type).filter((t): t is string => !!t),
	);
	const hasHttpBackend = [...types].some((t) => HTTP_BACKEND_TYPES.has(t));
	const hasFrontend = types.has("frontend");
	const hasDesktop = types.has("desktop");
	const hasDatabase = types.has("database");
	const hasAuth = types.has("auth");

	// ── Components table ────────────────────────────────────────────────
	const componentRows = nodes
		.map((n) => {
			const stack = n.data?.framework?.trim() || "—";
			return `| ${nodeName(n, s)} | ${roleFor(n.data?.type, lang)} | ${stack} |`;
		})
		.join("\n");

	// ── Connections ─────────────────────────────────────────────────────
	const connectionLines = cleanEdges
		.map((e) => {
			const src = byId.get(e.source);
			const tgt = byId.get(e.target);
			if (!src || !tgt) return null;
			const rel = e.data?.label?.trim();
			return `- **${nodeName(src, s)}** → **${nodeName(tgt, s)}**${rel ? ` (${rel})` : ""}`;
		})
		.filter((l): l is string => l !== null)
		.join("\n");

	// ── Tailored requirements ───────────────────────────────────────────
	const reqs: string[] = [s.reqBase1, s.reqBase2];
	if (hasHttpBackend) {
		reqs.push(s.reqHttp1, s.reqHttp2, s.reqHttp3);
	}
	if (hasFrontend && hasHttpBackend) {
		reqs.push(s.reqFeBe);
	} else if (hasFrontend) {
		reqs.push(s.reqFeOnly);
	}
	if (hasDesktop) reqs.push(s.reqDesktop);
	if (hasDatabase) reqs.push(s.reqDb);
	if (hasAuth) reqs.push(s.reqAuth);
	reqs.push(s.reqReadme, s.reqFlows);

	const description = [
		`# ${s.heading(kindLabel(diagramType, s))}`,
		"",
		s.intro,
		"",
		`## ${s.components}`,
		"",
		`| ${s.colComponent} | ${s.colRole} | ${s.colTech} |`,
		"| --- | --- | --- |",
		componentRows || "| (—) | | |",
		"",
		`## ${s.connections}`,
		"",
		connectionLines || s.noConnections,
		"",
		`## ${s.requirements}`,
		"",
		reqs.map((r) => `- ${r}`).join("\n"),
		"",
	].join("\n");

	// ── Title ───────────────────────────────────────────────────────────
	const stacks = [
		...new Set(
			nodes.map((n) => n.data?.framework?.trim()).filter((f): f is string => !!f),
		),
	];
	const titleStacks = stacks.length > 0 ? ` (${stacks.join(" + ")})` : "";
	const noun = hasHttpBackend
		? s.titleWebApi
		: hasDesktop
			? s.titleDesktop
			: hasFrontend
				? s.titleFrontend
				: s.titleGeneric;
	const title = s.titleVerb(noun, titleStacks);

	return { title, description };
}
