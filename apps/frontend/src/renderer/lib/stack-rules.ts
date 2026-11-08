/**
 * stack-rules — a link can be a valid architecture edge and still not work
 * with the stacks picked on its two blocks: a Celery worker cannot consume
 * Kafka, BullMQ and Sidekiq only run on Redis, a phone does not embed
 * PostgreSQL, a browser must not hold an Elasticsearch key…
 *
 * These are warnings, not refusals: the link is drawn, the inspector and the
 * coherence panel say what is wrong and what usually replaces it, and the
 * build spec passes it on to the coding agent.
 *
 * Pure and bilingual; `stack-rules.test.ts` pins each rule.
 */

import type { EndInfo, Lang } from "./architecture-connections";

interface Text {
	en: string;
	fr: string;
}

function norm(fw?: string): string {
	return (fw ?? "").toLowerCase().replace(/[\s._\-/()]+/g, "");
}

function fw(end: EndInfo, ...names: string[]): boolean {
	const f = norm(end.framework);
	return f !== "" && names.some((n) => norm(n) === f);
}

/** A stack is set and is none of `names`. */
function other(end: EndInfo, ...names: string[]): boolean {
	return norm(end.framework) !== "" && !fw(end, ...names);
}

const PYTHON = ["Python", "FastApi", "Django", "Flask"];
const NODE = ["NodeJs", "NextJs", "Nuxt", "Electron"];
const RUBY = ["Rails"];

interface Rule {
	applies: (src: EndInfo, tgt: EndInfo) => boolean;
	text: Text;
}

const RULES: Rule[] = [
	// ── Job runners and the broker they need ─────────────────────────────
	{
		applies: (s, t) =>
			(s.type === "queue" || s.type === "messagebroker") &&
			t.type === "worker" &&
			fw(t, "Celery") &&
			other(s, "RabbitMq", "Sqs"),
		text: {
			en: "Celery consumes RabbitMQ, Redis or Amazon SQS, not {sf}: change the broker, or the worker.",
			fr: "Celery consomme RabbitMQ, Redis ou Amazon SQS, pas {sf} : changez de broker, ou de worker.",
		},
	},
	{
		applies: (s, t) =>
			(s.type === "queue" || s.type === "messagebroker") &&
			t.type === "worker" &&
			fw(t, "BullMQ", "Sidekiq") &&
			norm(s.framework) !== "",
		text: {
			en: "{tf} keeps its jobs in Redis, not in {sf}: the job is handed over through Redis (a Cache or Database block with Redis).",
			fr: "{tf} garde ses jobs dans Redis, pas dans {sf} : le job passe par Redis (un bloc Cache ou Base de données en Redis).",
		},
	},
	{
		applies: (s, t) =>
			t.type === "worker" &&
			(s.type === "backend" || s.type === "microservice") &&
			((fw(t, "Celery") && other(s, ...PYTHON)) ||
				(fw(t, "BullMQ") && other(s, ...NODE)) ||
				(fw(t, "Sidekiq") && other(s, ...RUBY))),
		text: {
			en: "A {tf} job is enqueued from its own language, not from {sf}: hand the work over through a queue (RabbitMQ, SQS…) or an API instead.",
			fr: "Un job {tf} se met en file depuis son propre langage, pas depuis {sf} : confiez plutôt le travail par une file (RabbitMQ, SQS…) ou une API.",
		},
	},
	// ── Data on the device ───────────────────────────────────────────────
	{
		applies: (s, t) =>
			s.type === "mobile" && t.type === "database" && other(t, "Sqlite"),
		text: {
			en: "A phone does not embed {tf}: its local database is SQLite (or Realm). To reach {tf}, go through a Backend.",
			fr: "Un téléphone n'embarque pas {tf} : sa base locale est SQLite (ou Realm). Pour atteindre {tf}, passez par un Backend.",
		},
	},
	{
		applies: (s, t) =>
			(s.type === "backend" || s.type === "microservice" || s.type === "worker") &&
			t.type === "database" &&
			fw(t, "Sqlite"),
		text: {
			en: "SQLite is a file inside one process: a server that scales out or shares it with another service needs PostgreSQL, MySQL or SQL Server.",
			fr: "SQLite est un fichier dans un seul processus : un serveur qui se réplique ou la partage avec un autre service a besoin de PostgreSQL, MySQL ou SQL Server.",
		},
	},
	// ── Search from the browser ──────────────────────────────────────────
	{
		applies: (s, t) =>
			(s.type === "frontend" || s.type === "mobile") &&
			t.type === "search" &&
			fw(t, "Elasticsearch", "OpenSearch"),
		text: {
			en: "{tf} has no search-only key a client could hold: query it from the Backend (Meilisearch and Typesense do have one).",
			fr: "{tf} n'a pas de clé en lecture seule qu'un client pourrait porter : interrogez-le depuis le Backend (Meilisearch et Typesense en ont une).",
		},
	},
	// ── Delivery channels ────────────────────────────────────────────────
	{
		applies: (s, t) =>
			s.type === "notification" &&
			["frontend", "mobile", "desktop"].includes(t.type ?? "") &&
			fw(s, "SendGrid", "Smtp", "Twilio"),
		text: {
			en: "{sf} sends emails or texts, not push notifications: to push to an app, use Firebase (FCM / APNs) or Web Push.",
			fr: "{sf} envoie des e-mails ou des SMS, pas de notifications push : pour pousser vers une application, utilisez Firebase (FCM / APNs) ou Web Push.",
		},
	},
	// ── Origins a CDN can pull from ──────────────────────────────────────
	{
		applies: (s, t) => s.type === "cdn" && t.type === "storage" && fw(t, "LocalDisk"),
		text: {
			en: "A CDN cannot pull from a local disk: expose the files through object storage (S3, Azure Blob) or a backend.",
			fr: "Un CDN ne peut pas puiser dans un disque local : exposez les fichiers par un stockage objet (S3, Azure Blob) ou un backend.",
		},
	},
	// ── Caches ───────────────────────────────────────────────────────────
	{
		applies: (s, t) =>
			t.type === "cache" && fw(t, "Memcached") && s.type === "worker",
		text: {
			en: "Memcached may evict any entry at any time: state shared by workers (locks, progress) belongs in Redis or Valkey.",
			fr: "Memcached peut évincer une entrée à tout moment : l'état partagé entre workers (verrous, progression) va dans Redis ou Valkey.",
		},
	},
	// ── Gateways ─────────────────────────────────────────────────────────
	{
		applies: (s, t) =>
			s.type === "gateway" &&
			fw(s, "YARP") &&
			(t.type === "frontend" || t.type === "storage"),
		text: {
			en: "YARP is a reverse proxy inside an ASP.NET Core app: static files are better served by the CDN or the web server.",
			fr: "YARP est un proxy inverse dans une application ASP.NET Core : les fichiers statiques sont mieux servis par le CDN ou le serveur web.",
		},
	},
];

/**
 * What does not fit between the stacks of the two ends of a link, as
 * sentences in the app's language (empty when nothing is wrong). `resolve`
 * turns a stack id into its display name (`Sqs` → "Amazon SQS").
 */
export function stackWarnings(
	src: EndInfo,
	tgt: EndInfo,
	lang: Lang,
	resolve: (stack: string) => string = (k) => k,
): string[] {
	return RULES.filter((r) => r.applies(src, tgt)).map((r) =>
		r.text[lang]
			.replaceAll("{sf}", resolve(src.framework ?? ""))
			.replaceAll("{tf}", resolve(tgt.framework ?? "")),
	);
}
