/**
 * architecture-connections — which architecture blocks connect, what the
 * connection is called, and what it means.
 *
 * Goals:
 *  - Know every *coherent* software-architecture edge: a backend handing jobs
 *    to a worker, a worker writing to its database, a server pushing to its
 *    clients over SignalR / WebSocket, a provider calling back by webhook, a
 *    database streaming its changes, every block reporting to monitoring…
 *    The table follows the request / data-flow direction.
 *  - Give every known edge a spoken label ("HTTP / REST", "lit / écrit", …)
 *    and a sentence, so the diagram reads as an architecture and the
 *    generated spec is precise.
 *  - Offer, per pair *and per stack*, the relations that make sense
 *    (connection-protocols.ts), for the inspector's drop-down.
 *
 * An edge outside the table is *unusual*, not forbidden: the canvas asks
 * before drawing it (`canConnect` false) and the person can force it.
 *
 * Pure + bilingual (fr/en) so it can be unit tested and reused anywhere.
 */

import {
	type EndInfo,
	type InteractionKind,
	type Lang,
	protocolsFor,
} from "./connection-protocols";

export type { EndInfo, Lang };

interface Text {
	en: string;
	fr: string;
}

interface Verb {
	/** The short relation written on the wire. */
	label: Text;
	/**
	 * What the relation *means*, as a sentence: the text written between two
	 * blocks so a diagram explains itself to someone who did not draw it, and
	 * the line the coding agent reads under each connection of the build spec.
	 * `{s}` and `{t}` are the source and target block names. It never names a
	 * protocol: the person may pick another one in the inspector.
	 */
	explain: Text;
}

const VERBS = {
	requestsVia: {
		label: { en: "requests via", fr: "passe par" },
		explain: {
			en: "{s} sends every request through {t}",
			fr: "{s} fait passer toutes ses requêtes par {t}",
		},
	},
	callsApi: {
		label: { en: "HTTP / REST", fr: "HTTP / REST" },
		explain: {
			en: "{s} calls the API exposed by {t}",
			fr: "{s} appelle l'API exposée par {t}",
		},
	},
	authenticatesVia: {
		label: { en: "authenticates via", fr: "s'authentifie via" },
		explain: {
			en: "{s} signs the user in through {t} and keeps the token",
			fr: "{s} connecte l'utilisateur via {t} et conserve son jeton",
		},
	},
	loadsAssets: {
		label: { en: "loads assets from", fr: "charge les assets depuis" },
		explain: {
			en: "{s} loads its static files (scripts, styles, images) from {t}",
			fr: "{s} charge ses fichiers statiques (scripts, styles, images) depuis {t}",
		},
	},
	sendsEvents: {
		label: { en: "sends events to", fr: "envoie les événements à" },
		explain: {
			en: "{s} sends its usage events to {t}",
			fr: "{s} envoie ses événements d'usage à {t}",
		},
	},
	receives: {
		label: { en: "receives", fr: "reçoit" },
		explain: {
			en: "{s} receives the notifications pushed by {t}",
			fr: "{s} reçoit les notifications poussées par {t}",
		},
	},
	calls: {
		label: { en: "calls", fr: "appelle" },
		explain: {
			en: "{s} calls {t} for a capability it does not own",
			fr: "{s} appelle {t} pour une capacité qu'il ne porte pas",
		},
	},
	readsWrites: {
		label: { en: "reads / writes", fr: "lit / écrit" },
		explain: {
			en: "{s} reads and writes its data in {t}",
			fr: "{s} lit et écrit ses données dans {t}",
		},
	},
	storesLocally: {
		label: { en: "stores locally in", fr: "stocke en local dans" },
		explain: {
			en: "{s} keeps its data on the device in {t}, usable offline",
			fr: "{s} garde ses données sur l'appareil dans {t}, utilisables hors ligne",
		},
	},
	storesFiles: {
		label: { en: "stores files in", fr: "stocke les fichiers dans" },
		explain: {
			en: "{s} stores its files in {t}",
			fr: "{s} stocke ses fichiers dans {t}",
		},
	},
	uploadsTo: {
		label: { en: "uploads to", fr: "téléverse dans" },
		explain: {
			en: "{s} uploads files straight to {t} with a short-lived link",
			fr: "{s} envoie ses fichiers directement dans {t} avec un lien à durée limitée",
		},
	},
	cachesIn: {
		label: { en: "caches in", fr: "met en cache dans" },
		explain: {
			en: "{s} keeps frequent reads in {t} to answer faster",
			fr: "{s} garde les lectures fréquentes dans {t} pour répondre plus vite",
		},
	},
	reportsTo: {
		label: { en: "reports to", fr: "remonte vers" },
		explain: {
			en: "{s} sends its logs, metrics and traces to {t}",
			fr: "{s} envoie ses logs, métriques et traces à {t}",
		},
	},
	routesTo: {
		label: { en: "routes to", fr: "route vers" },
		explain: {
			en: "{s} forwards each request to {t}",
			fr: "{s} transmet chaque requête à {t}",
		},
	},
	verifiesToken: {
		label: { en: "verifies token via", fr: "vérifie le jeton via" },
		explain: {
			en: "{s} checks the token of each request with {t}",
			fr: "{s} vérifie le jeton de chaque requête auprès de {t}",
		},
	},
	indexesQueries: {
		label: { en: "indexes / queries", fr: "indexe / interroge" },
		explain: {
			en: "{s} indexes its content in {t} and queries it to search",
			fr: "{s} indexe son contenu dans {t} et l'interroge pour chercher",
		},
	},
	queries: {
		label: { en: "queries", fr: "interroge" },
		explain: {
			en: "{s} queries {t} directly to search",
			fr: "{s} interroge {t} directement pour chercher",
		},
	},
	publishesTo: {
		label: { en: "publishes to", fr: "publie dans" },
		explain: {
			en: "{s} publishes messages to {t} without waiting for them to be handled",
			fr: "{s} publie des messages dans {t} sans attendre leur traitement",
		},
	},
	validatesVia: {
		label: { en: "validates via", fr: "valide via" },
		explain: {
			en: "{s} validates tokens and permissions with {t}",
			fr: "{s} valide les jetons et les droits auprès de {t}",
		},
	},
	getsToken: {
		label: { en: "gets a token from", fr: "obtient un jeton de" },
		explain: {
			en: "{s} gets its own service token from {t}",
			fr: "{s} obtient son propre jeton de service auprès de {t}",
		},
	},
	federatesWith: {
		label: { en: "federates with", fr: "fédère avec" },
		explain: {
			en: "{s} lets users sign in with their {t} account",
			fr: "{s} permet de se connecter avec un compte {t}",
		},
	},
	sendsVia: {
		label: { en: "sends via", fr: "envoie via" },
		explain: {
			en: "{s} sends emails, texts or push notifications through {t}",
			fr: "{s} envoie e-mails, SMS ou notifications push via {t}",
		},
	},
	uses: {
		label: { en: "uses", fr: "utilise" },
		explain: {
			en: "{s} uses {t} to share short-lived state",
			fr: "{s} utilise {t} pour partager un état de courte durée",
		},
	},
	storesIn: {
		label: { en: "stores in", fr: "stocke dans" },
		explain: {
			en: "{s} stores what it produces in {t}",
			fr: "{s} stocke ce qu'il produit dans {t}",
		},
	},
	indexes: {
		label: { en: "indexes", fr: "indexe" },
		explain: {
			en: "{s} keeps the {t} index up to date",
			fr: "{s} tient l'index de {t} à jour",
		},
	},
	consumedBy: {
		label: { en: "consumed by", fr: "consommée par" },
		explain: {
			en: "{t} consumes the messages waiting in {s}, one at a time",
			fr: "{t} consomme les messages en attente dans {s}, un par un",
		},
	},
	deliversTo: {
		label: { en: "delivers to", fr: "distribue à" },
		explain: {
			en: "{s} delivers each published event to {t}",
			fr: "{s} distribue chaque événement publié à {t}",
		},
	},
	serves: {
		label: { en: "serves", fr: "sert" },
		explain: {
			en: "{s} serves the static files of {t} close to its users",
			fr: "{s} sert les fichiers statiques de {t} au plus près des utilisateurs",
		},
	},
	origin: {
		label: { en: "origin", fr: "origine" },
		explain: {
			en: "{s} fetches from {t} the files it does not have in cache",
			fr: "{s} va chercher dans {t} les fichiers qu'il n'a pas en cache",
		},
	},
	purges: {
		label: { en: "purges", fr: "purge" },
		explain: {
			en: "{s} clears the files of {t} that are out of date",
			fr: "{s} vide dans {t} les fichiers devenus obsolètes",
		},
	},
	triggers: {
		label: { en: "triggers", fr: "déclenche" },
		explain: {
			en: "{s} hands work to {t}, which runs it in the background",
			fr: "{s} confie du travail à {t}, qui l'exécute en arrière-plan",
		},
	},
	reportsBack: {
		label: { en: "reports back to", fr: "rend compte à" },
		explain: {
			en: "{s} sends the result of its work back to {t}",
			fr: "{s} renvoie le résultat de son travail à {t}",
		},
	},
	pushesTo: {
		label: { en: "pushes to", fr: "pousse vers" },
		explain: {
			en: "{s} pushes updates to {t} in real time",
			fr: "{s} pousse les mises à jour vers {t} en temps réel",
		},
	},
	callsBack: {
		label: { en: "calls back", fr: "rappelle" },
		explain: {
			en: "{s} notifies {t} of its events through a webhook",
			fr: "{s} prévient {t} de ses événements par webhook",
		},
	},
	loadsModule: {
		label: { en: "embeds", fr: "intègre" },
		explain: {
			en: "{s} embeds {t} as a part of its own pages",
			fr: "{s} intègre {t} comme une partie de ses propres pages",
		},
	},
	streamsChanges: {
		label: { en: "streams changes to", fr: "diffuse ses changements vers" },
		explain: {
			en: "{s} streams every change of its data to {t}",
			fr: "{s} diffuse chaque changement de ses données vers {t}",
		},
	},
	replicatesTo: {
		label: { en: "replicates to", fr: "réplique vers" },
		explain: {
			en: "{s} copies its data to {t}, which keeps a replica",
			fr: "{s} copie ses données vers {t}, qui en garde une réplique",
		},
	},
	feeds: {
		label: { en: "feeds", fr: "alimente" },
		explain: {
			en: "{s} copies each message it receives into {t}",
			fr: "{s} recopie chaque message reçu dans {t}",
		},
	},
	mirrorsTo: {
		label: { en: "mirrors to", fr: "recopie vers" },
		explain: {
			en: "{s} copies its messages to {t}",
			fr: "{s} recopie ses messages vers {t}",
		},
	},
	deadLettersTo: {
		label: { en: "dead-letters to", fr: "rejette vers" },
		explain: {
			en: "{s} moves the messages it could not deliver to {t}",
			fr: "{s} déplace vers {t} les messages qu'elle n'a pas pu remettre",
		},
	},
	emitsEvents: {
		label: { en: "emits events to", fr: "émet des événements vers" },
		explain: {
			en: "{s} emits an event to {t} for each file added or changed",
			fr: "{s} émet un événement vers {t} pour chaque fichier ajouté ou modifié",
		},
	},
	alertsVia: {
		label: { en: "alerts via", fr: "alerte via" },
		explain: {
			en: "{s} raises its alerts through {t}",
			fr: "{s} déclenche ses alertes via {t}",
		},
	},
	exportsTo: {
		label: { en: "exports to", fr: "exporte vers" },
		explain: {
			en: "{s} exports the data it collected to {t}",
			fr: "{s} exporte les données collectées vers {t}",
		},
	},
	connectsTo: {
		label: { en: "connects to", fr: "relié à" },
		explain: { en: "{s} exchanges with {t}", fr: "{s} échange avec {t}" },
	},
} satisfies Record<string, Verb>;

type VerbId = keyof typeof VERBS;

/** One known edge: what it means and how the two ends usually talk. */
type Rule = [VerbId, InteractionKind];

// Groups shared by several sources, so a backend and a microservice cannot
// drift apart again (the worker → database gap came from such a drift).
const CLIENT_COMMON: Record<string, Rule> = {
	gateway: ["requestsVia", "api"],
	backend: ["callsApi", "api"],
	microservice: ["callsApi", "api"],
	auth: ["authenticatesVia", "authClient"],
	cdn: ["loadsAssets", "assets"],
	analytics: ["sendsEvents", "analytics"],
	notification: ["receives", "push"],
	thirdparty: ["calls", "thirdparty"],
	storage: ["uploadsTo", "storageClient"],
	search: ["queries", "searchClient"],
};

const SERVICE_COMMON: Record<string, Rule> = {
	database: ["readsWrites", "data"],
	cache: ["cachesIn", "cache"],
	search: ["indexesQueries", "search"],
	queue: ["publishesTo", "publish"],
	messagebroker: ["publishesTo", "publish"],
	storage: ["storesFiles", "storage"],
	thirdparty: ["calls", "thirdparty"],
	auth: ["validatesVia", "authServer"],
	notification: ["sendsVia", "notify"],
	backend: ["calls", "serviceCall"],
	microservice: ["calls", "serviceCall"],
	worker: ["triggers", "job"],
	analytics: ["sendsEvents", "analytics"],
	frontend: ["pushesTo", "push"],
	mobile: ["pushesTo", "push"],
	desktop: ["pushesTo", "push"],
	cdn: ["purges", "purge"],
};

/**
 * Directed adjacency: RULES[source][target]. `monitoring` is left out: every
 * typed block may report to it (see {@link ruleFor}).
 */
const RULES: Record<string, Record<string, Rule>> = {
	frontend: {
		...CLIENT_COMMON,
		// Micro-frontends: a shell page embedding a remote one.
		frontend: ["loadsModule", "microfrontend"],
	},
	mobile: {
		...CLIENT_COMMON,
		// The on-device database (SQLite, Room, Core Data…) of an offline app.
		database: ["storesLocally", "localData"],
	},
	desktop: {
		// A thick client can talk directly to the DB (classic 2-tier) OR go
		// through a backend/API (3-tier) — both are legitimate desktop patterns.
		...CLIENT_COMMON,
		database: ["readsWrites", "data"],
		storage: ["storesFiles", "storage"],
		cache: ["cachesIn", "cache"],
		// Industrial / enterprise thick clients publish to a broker directly.
		queue: ["publishesTo", "publish"],
		messagebroker: ["publishesTo", "publish"],
	},
	gateway: {
		backend: ["routesTo", "route"],
		microservice: ["routesTo", "route"],
		frontend: ["routesTo", "route"],
		thirdparty: ["routesTo", "route"],
		gateway: ["routesTo", "route"],
		storage: ["routesTo", "route"],
		auth: ["verifiesToken", "authServer"],
		cache: ["cachesIn", "cache"],
	},
	backend: { ...SERVICE_COMMON },
	microservice: { ...SERVICE_COMMON },
	worker: {
		// A worker owns the data it produces as often as not (EF Core in a .NET
		// Worker Service, the ORM of a Celery or Sidekiq job).
		database: ["readsWrites", "data"],
		cache: ["uses", "cache"],
		storage: ["storesIn", "storage"],
		search: ["indexes", "search"],
		queue: ["publishesTo", "publish"],
		messagebroker: ["publishesTo", "publish"],
		backend: ["reportsBack", "serviceCall"],
		microservice: ["reportsBack", "serviceCall"],
		thirdparty: ["calls", "thirdparty"],
		notification: ["sendsVia", "notify"],
		auth: ["getsToken", "authMachine"],
		analytics: ["sendsEvents", "analytics"],
		cdn: ["purges", "purge"],
	},
	queue: {
		worker: ["consumedBy", "consume"],
		backend: ["consumedBy", "consume"],
		microservice: ["consumedBy", "consume"],
		queue: ["deadLettersTo", "deadLetter"],
	},
	messagebroker: {
		worker: ["deliversTo", "consume"],
		backend: ["deliversTo", "consume"],
		microservice: ["deliversTo", "consume"],
		queue: ["deliversTo", "brokerRoute"],
		messagebroker: ["mirrorsTo", "brokerMirror"],
		// Sink connectors (Kafka Connect, Logstash…) fill a store from a topic.
		search: ["feeds", "brokerSink"],
		database: ["feeds", "brokerSink"],
		storage: ["feeds", "brokerSink"],
	},
	database: {
		search: ["streamsChanges", "cdc"],
		queue: ["streamsChanges", "cdc"],
		messagebroker: ["streamsChanges", "cdc"],
		database: ["replicatesTo", "replication"],
	},
	cache: {
		cache: ["replicatesTo", "replication"],
	},
	storage: {
		storage: ["replicatesTo", "replication"],
		queue: ["emitsEvents", "objectEvents"],
		messagebroker: ["emitsEvents", "objectEvents"],
		worker: ["emitsEvents", "objectEvents"],
	},
	cdn: {
		frontend: ["serves", "assets"],
		storage: ["origin", "origin"],
		backend: ["origin", "origin"],
		gateway: ["origin", "origin"],
	},
	auth: {
		database: ["readsWrites", "data"],
		cache: ["cachesIn", "cache"],
		notification: ["sendsVia", "notify"],
		thirdparty: ["federatesWith", "federation"],
		// Identity events (sign-up, login) for the rest of the system.
		queue: ["publishesTo", "publish"],
		messagebroker: ["publishesTo", "publish"],
	},
	thirdparty: {
		backend: ["callsBack", "webhook"],
		microservice: ["callsBack", "webhook"],
		gateway: ["callsBack", "webhook"],
		queue: ["publishesTo", "publish"],
		messagebroker: ["publishesTo", "publish"],
	},
	notification: {
		frontend: ["pushesTo", "push"],
		mobile: ["pushesTo", "push"],
		desktop: ["pushesTo", "push"],
		thirdparty: ["sendsVia", "notify"],
		// Delivery and bounce statuses come back by webhook.
		backend: ["callsBack", "webhook"],
		microservice: ["callsBack", "webhook"],
	},
	monitoring: {
		notification: ["alertsVia", "alerting"],
		thirdparty: ["alertsVia", "alerting"],
	},
	analytics: {
		database: ["exportsTo", "export"],
		storage: ["exportsTo", "export"],
		thirdparty: ["exportsTo", "export"],
	},
};

/** Types whose connections are free by design: no rule, no question asked. */
function isFree(type: string | undefined): boolean {
	return !type || type === "custom";
}

function ruleFor(
	sourceType: string | undefined,
	targetType: string | undefined,
): Rule | undefined {
	if (!sourceType || !targetType) return undefined;
	const rule = RULES[sourceType]?.[targetType];
	if (rule) return rule;
	if (targetType === "monitoring" && sourceType !== "monitoring") {
		return ["reportsTo", "telemetry"];
	}
	return undefined;
}

function pick(text: Text, lang: Lang): string {
	return lang === "fr" ? text.fr : text.en;
}

/**
 * Whether an edge from `sourceType` to `targetType` is a coherent
 * architecture edge. Untyped nodes (plain flowchart boxes) and `custom`
 * blocks are permissive escape hatches. `false` means *unusual*, not
 * impossible: the canvas asks before drawing it.
 */
export function canConnect(
	sourceType: string | undefined,
	targetType: string | undefined,
): boolean {
	if (isFree(sourceType) || isFree(targetType)) return true;
	return ruleFor(sourceType, targetType) !== undefined;
}

/**
 * The spoken relationship label for a (source → target) edge, localized.
 * Falls back to a generic label for permissive or forced connections.
 */
export function connectionLabel(
	sourceType: string | undefined,
	targetType: string | undefined,
	lang: Lang = "en",
): string {
	const rule = ruleFor(sourceType, targetType);
	return pick(VERBS[rule?.[0] ?? "connectsTo"].label, lang);
}

/**
 * The relations to offer for this edge in the inspector, most likely first:
 * the canvas' own label, then the protocols and libraries usual between
 * these two blocks *with their stacks* (gRPC, SignalR, MassTransit, EF Core,
 * FCM / APNs…). The inspector adds a free-text entry after them.
 */
export function relationOptions(
	source: EndInfo,
	target: EndInfo,
	lang: Lang = "en",
): string[] {
	const rule = ruleFor(source.type, target.type);
	const kind: InteractionKind = rule?.[1] ?? "generic";
	return [
		...new Set([
			connectionLabel(source.type, target.type, lang),
			...protocolsFor(kind, source, target, lang),
		]),
	];
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
	const rule = ruleFor(sourceType, targetType);
	return pick(VERBS[rule?.[0] ?? "connectsTo"].explain, lang)
		.replaceAll("{s}", sourceName)
		.replaceAll("{t}", targetName);
}

/** Every (source, target) pair the table knows, for the coverage tests. */
export function knownPairs(): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const [src, targets] of Object.entries(RULES)) {
		for (const tgt of Object.keys(targets)) pairs.push([src, tgt]);
	}
	return pairs;
}
