/**
 * connection-verdicts — *why* a link between two blocks is not an
 * architecture edge, and what to put between them instead.
 *
 * `canConnect` says yes or no; a bare "no" taught nothing and left the person
 * guessing. Every pair of block types the table does not know gets here a
 * reason drawn from the usual application-architecture rules:
 *
 *  - layering: a client never reaches a data store or a message broker
 *    directly, it goes through a service (Clean / hexagonal architecture,
 *    the backend owns its data and its business rules);
 *  - data stores and queues are passive: they answer, they do not call;
 *  - a gateway is the clients' entry point, never a hop between services;
 *  - a worker runs in the background and is not reachable by the user;
 *  - identity providers, CDNs, observability and outside services each have
 *    one way in and one way out.
 *
 * When the pair is simply drawn backwards, the verdict says so, and the
 * canvas offers to flip it. `connection-verdicts.test.ts` checks that every
 * pair of the palette is either a known edge or gets a reason of its own.
 *
 * Pure and bilingual.
 */

import { blockMeta } from "./architecture-blocks";
import {
	canConnect,
	explainConnection,
	type Lang,
} from "./architecture-connections";

interface Text {
	en: string;
	fr: string;
}

export interface Verdict {
	ok: boolean;
	/** Why the link is not an architecture edge (absent when `ok`). */
	reason?: string;
	/** The opposite direction is a known edge: the arrow was drawn backwards. */
	reversed?: boolean;
	/** Block types that usually sit between the two, to suggest. */
	via?: string[];
}

type Role =
	| "client"
	| "entry"
	| "edge"
	| "service"
	| "worker"
	| "store"
	| "messaging"
	| "identity"
	| "external"
	| "delivery"
	| "observer";

const ROLE: Record<string, Role> = {
	frontend: "client",
	mobile: "client",
	desktop: "client",
	gateway: "entry",
	cdn: "edge",
	backend: "service",
	microservice: "service",
	worker: "worker",
	database: "store",
	cache: "store",
	search: "store",
	storage: "store",
	queue: "messaging",
	messagebroker: "messaging",
	auth: "identity",
	thirdparty: "external",
	notification: "delivery",
	monitoring: "observer",
	analytics: "observer",
};

/** Why a rule fires: `{s}` / `{t}` are block names, `{T}` the target's kind. */
const REASONS: Record<string, Text> = {
	sameType: {
		en: "Two “{S}” blocks linked directly do not make an architecture: merge them, or let a service sit between them.",
		fr: "Deux blocs « {S} » reliés directement ne forment pas une architecture : fusionnez-les, ou faites passer l'échange par un service.",
	},
	clientToData: {
		en: "A client never talks to a “{T}” block directly: it would carry the credentials and skip the business rules. Go through a Backend or an API Gateway.",
		fr: "Un client ne parle jamais directement à un bloc « {T} » : il en porterait les accès et contournerait les règles métier. Passez par un Backend ou une API Gateway.",
	},
	clientToWorker: {
		en: "A worker exposes no API to clients: the Backend takes the request and hands it to the worker (directly or through a queue).",
		fr: "Un worker n'expose pas d'API aux clients : le Backend reçoit la demande et la confie au worker (directement ou par une file).",
	},
	clientToClient: {
		en: "Two client applications do not talk to each other: they share a Backend, which pushes to both in real time.",
		fr: "Deux applications clientes ne se parlent pas : elles partagent un Backend, qui pousse vers chacune en temps réel.",
	},
	passiveStore: {
		en: "A “{S}” block is passive: it answers requests, it does not send any. A service reads and writes it.",
		fr: "Un bloc « {S} » est passif : il répond aux requêtes, il n'en émet pas. C'est un service qui le lit et l'écrit.",
	},
	messagingOut: {
		en: "A “{S}” block only delivers its messages to consumers: a Worker, a Backend or a Microservice.",
		fr: "Un bloc « {S} » ne livre ses messages qu'à des consommateurs : un Worker, un Backend ou un Microservice.",
	},
	workerToClient: {
		en: "A worker runs in the background, with no link to the user: it tells the Backend, which pushes in real time, or goes through Notification.",
		fr: "Un worker tourne en arrière-plan, sans lien avec l'utilisateur : il prévient le Backend, qui pousse en temps réel, ou passe par Notification.",
	},
	viaGateway: {
		en: "The gateway is the clients' way in: between services the call is direct (or through a service mesh).",
		fr: "La gateway est la porte d'entrée des clients : entre services, l'appel est direct (ou passe par un service mesh).",
	},
	gatewayOut: {
		en: "A gateway routes to services, never to a “{T}” block: a service owns it.",
		fr: "Une gateway route vers des services, jamais vers un bloc « {T} » : c'est un service qui le porte.",
	},
	cdnOut: {
		en: "A CDN serves files and fetches them from its origin (storage, backend or gateway), nothing else.",
		fr: "Un CDN sert des fichiers et va les chercher à son origine (stockage, backend ou gateway), rien d'autre.",
	},
	identityOut: {
		en: "The identity provider waits to be asked: clients and services connect to it, not the other way round.",
		fr: "Le fournisseur d'identité attend qu'on vienne à lui : ce sont les clients et les services qui s'y connectent.",
	},
	externalIn: {
		en: "An outside service only knows your public entry point: it calls a Backend or a gateway back (webhook), or publishes to a queue.",
		fr: "Un service tiers ne connaît que votre point d'entrée public : il rappelle un Backend ou une gateway (webhook), ou publie dans une file.",
	},
	deliveryOut: {
		en: "Notification only delivers messages to people (email, SMS, push) and reports their status back to the Backend.",
		fr: "Notification ne fait que livrer des messages aux personnes (e-mail, SMS, push) et en renvoyer le statut au Backend.",
	},
	observerOut: {
		en: "A “{S}” block receives data, it does not call the blocks: only alerts (Notification, an outside tool) and exports leave it.",
		fr: "Un bloc « {S} » reçoit des données, il n'appelle pas les blocs : seules les alertes (Notification, outil tiers) et les exports en partent.",
	},
	toObserver: {
		en: "A “{T}” block only receives data: link it from the block that produces the events.",
		fr: "Un bloc « {T} » ne fait que recevoir des données : reliez-le depuis le bloc qui produit les événements.",
	},
	serviceToEdge: {
		en: "A service puts its files behind a CDN through storage, and only purges the CDN.",
		fr: "Un service passe par le stockage pour mettre ses fichiers derrière un CDN, et ne fait que purger le CDN.",
	},
	reversed: {
		en: "The arrow points the wrong way: {sentence}. Draw it in that direction.",
		fr: "La flèche est dans le mauvais sens : {sentence}. Tracez-la dans ce sens.",
	},
	unknown: {
		en: "The architecture rules do not foresee this link.",
		fr: "Les règles d'architecture ne prévoient pas ce lien.",
	},
};

/** The rule that refuses the pair, and the blocks to suggest in between. */
function refusal(
	src: string,
	tgt: string,
): { key: keyof typeof REASONS; via?: string[] } {
	const s = ROLE[src];
	const t = ROLE[tgt];
	if (src === tgt) return { key: "sameType", via: ["backend"] };
	if (s === "client") {
		if (t === "store" || t === "messaging")
			return { key: "clientToData", via: ["backend", "gateway"] };
		if (t === "worker") return { key: "clientToWorker", via: ["backend", "queue"] };
		if (t === "client") return { key: "clientToClient", via: ["backend"] };
		if (t === "observer") return { key: "toObserver" };
	}
	if (s === "store") return { key: "passiveStore", via: ["backend"] };
	if (s === "messaging") return { key: "messagingOut", via: ["worker", "backend"] };
	if (s === "worker" && t === "client")
		return { key: "workerToClient", via: ["backend", "notification"] };
	if ((s === "worker" || s === "service") && t === "entry")
		return { key: "viaGateway" };
	if (s === "service" && t === "edge") return { key: "serviceToEdge", via: ["storage"] };
	if (s === "entry") return { key: "gatewayOut", via: ["backend"] };
	if (s === "edge") return { key: "cdnOut" };
	if (s === "identity") return { key: "identityOut" };
	if (s === "external") return { key: "externalIn", via: ["backend", "gateway"] };
	if (s === "delivery") return { key: "deliveryOut" };
	if (s === "observer") return { key: "observerOut" };
	if (t === "observer") return { key: "toObserver" };
	return { key: "unknown" };
}

function kindName(type: string, resolve: (key: string) => string): string {
	const meta = blockMeta(type);
	return meta ? resolve(meta.labelKey) : type;
}

/**
 * Whether linking `source` → `target` is an architecture edge and, when it is
 * not, why and what to do instead. `resolve` translates a block-type label
 * key (the caller's i18n); names are the blocks' own names.
 */
export function connectionVerdict(
	sourceType: string | undefined,
	targetType: string | undefined,
	names: { source: string; target: string },
	lang: Lang,
	resolve: (key: string) => string = (k) => k,
): Verdict {
	if (canConnect(sourceType, targetType)) return { ok: true };
	const src = sourceType as string;
	const tgt = targetType as string;
	if (canConnect(tgt, src)) {
		const sentence = explainConnection(tgt, src, names.target, names.source, lang);
		return {
			ok: false,
			reversed: true,
			reason: REASONS.reversed[lang].replace("{sentence}", sentence),
		};
	}
	const { key, via } = refusal(src, tgt);
	const reason = REASONS[key][lang]
		.replaceAll("{S}", kindName(src, resolve))
		.replaceAll("{T}", kindName(tgt, resolve));
	return { ok: false, reason, via };
}

/** Whether the pair falls through every rule (for the coverage test). */
export function isUnexplained(sourceType: string, targetType: string): boolean {
	if (canConnect(sourceType, targetType) || canConnect(targetType, sourceType))
		return false;
	return refusal(sourceType, targetType).key === "unknown";
}
