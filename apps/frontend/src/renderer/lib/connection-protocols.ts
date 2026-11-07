/**
 * connection-protocols — the relations a person can pick for a connection,
 * given what the two blocks are *and what they are built with*.
 *
 * The canvas used to offer one label per pair of block types and a free-text
 * field. A .NET backend talking to a .NET worker could only be "HTTP / REST",
 * and nobody would think of typing "MassTransit" or "Hangfire job" there. This
 * table answers "how do these two usually talk?" per kind of interaction, then
 * narrows by stack: SignalR when one end is .NET, tRPC between TypeScript and
 * Node, EF Core / JPA / Prisma / Eloquent… against a SQL database, AMQP or the
 * Kafka protocol by broker, FCM / APNs towards a phone, and so on.
 *
 * The lists follow the stacks of the palette (architecture-blocks.ts) and the
 * language skills shipped with WorkPilot (skills/dotnet, skills/mobile, the
 * BMAD architect): every stack offered on a block gets its usual library here.
 * A protocol nobody foresaw stays one keystroke away: the inspector always
 * ends its list with a free-text entry.
 *
 * Pure: no React, no i18n runtime, unit tested in connection-protocols.test.ts.
 */

export type Lang = "fr" | "en";

/** A protocol name, or its two spellings when French says it differently. */
export type Option = string | { en: string; fr: string };

/** What a connection does, independent of the blocks' stacks. */
export type InteractionKind =
	| "api" // a client calls a service
	| "serviceCall" // a service calls another service
	| "route" // a gateway forwards to what is behind it
	| "job" // a service hands work to a background worker
	| "data" // reads / writes a database
	| "localData" // a device keeps its data on itself
	| "cache"
	| "search"
	| "searchClient" // a client queries a search engine directly
	| "publish" // writes to a queue or a broker
	| "consume" // a queue or broker hands messages to a consumer
	| "storage"
	| "storageClient" // a client uploads straight to object storage
	| "thirdparty"
	| "webhook" // an outside service calls back
	| "authClient" // a user signs in
	| "authServer" // a service checks tokens
	| "authMachine" // a service gets its own token
	| "federation" // the identity provider delegates to another one
	| "notify" // a service sends an email / SMS / push
	| "push" // something pushes to a client in real time
	| "telemetry"
	| "analytics"
	| "assets" // a client loads static files from a CDN
	| "origin" // a CDN fetches what it does not have
	| "purge" // a service invalidates a CDN
	| "microfrontend"
	| "cdc" // a database streams its changes
	| "replication"
	| "brokerRoute" // a broker feeds a queue
	| "brokerMirror"
	| "deadLetter"
	| "objectEvents" // object storage emits events
	| "alerting"
	| "export"
	| "generic";

export interface EndInfo {
	type?: string;
	/** The stack picked on the block, as stored (`DotNet`, `Spring`, …) or typed. */
	framework?: string;
}

// ── Stack families ──────────────────────────────────────────────────────────
// Keys are the palette's stack ids lower-cased; the aliases cover what people
// type in a block whose type has no stack list (".NET", "asp.net core", "C#").

function norm(fw?: string): string {
	return (fw ?? "").toLowerCase().replace(/[\s._\-/()]+/g, "");
}

const FAMILY: Record<string, string[]> = {
	dotnet: [
		"dotnet",
		"net",
		"aspnet",
		"aspnetcore",
		"csharp",
		"c#",
		"blazor",
		"dotnetmaui",
		"maui",
		"wpf",
		"winforms",
		"winui",
		"avalonia",
		"yarp",
	],
	jvm: ["spring", "springboot", "quarkus", "ktor", "java", "kotlin", "micronaut"],
	node: ["nodejs", "node", "express", "nestjs", "nextjs", "nuxt", "electron", "bullmq", "fastify"],
	python: ["python", "fastapi", "django", "flask", "celery"],
	go: ["go", "golang"],
	rust: ["rust", "tauri", "axum", "actix"],
	php: ["laravel", "symfony", "php"],
	ruby: ["rails", "rubyonrails", "ruby", "sidekiq"],
	/** Runs in a browser: no native gRPC, Web Push for notifications. */
	browser: [
		"react",
		"angular",
		"vue",
		"svelte",
		"nextjs",
		"nuxt",
		"blazor",
		"typescript",
		"javascript",
	],
	/** Speaks TypeScript end to end, so tRPC is on the table. */
	ts: [
		"react",
		"angular",
		"vue",
		"svelte",
		"nextjs",
		"nuxt",
		"typescript",
		"javascript",
		"nodejs",
		"node",
		"nestjs",
		"electron",
		"reactnative",
		"ionic",
	],
};

function is(end: EndInfo, family: keyof typeof FAMILY): boolean {
	const f = norm(end.framework);
	return f !== "" && FAMILY[family].includes(f);
}

function fw(end: EndInfo, ...names: string[]): boolean {
	const f = norm(end.framework);
	return names.some((n) => norm(n) === f);
}

// ── Shared spellings ────────────────────────────────────────────────────────

const REST = "HTTP / REST";
const GRPC = "gRPC";
const GRAPHQL = "GraphQL";
const WS = "WebSocket";
const SSE = "SSE (Server-Sent Events)";
const QUEUE: Option = { en: "Message queue", fr: "File de messages" };
const SDK: Option = { en: "Vendor SDK", fr: "SDK de l'éditeur" };
const SQL: Option = { en: "SQL (driver)", fr: "SQL (pilote)" };
const OTLP = "OpenTelemetry (OTLP)";

// ── Stack-specific libraries ────────────────────────────────────────────────

/** How a stack reads and writes a SQL database, most usual first. */
function sqlAccess(end: EndInfo): Option[] {
	if (fw(end, "Django")) return ["Django ORM"];
	if (fw(end, "Celery")) return ["SQLAlchemy", "Django ORM"];
	if (fw(end, "FastApi")) return ["SQLAlchemy", "SQLModel"];
	if (is(end, "python")) return ["SQLAlchemy"];
	if (fw(end, "Quarkus")) return ["Hibernate ORM with Panache", "JDBC"];
	if (fw(end, "Ktor")) return ["Exposed", "JDBC"];
	if (fw(end, "Kotlin")) return ["Room"];
	if (is(end, "jvm")) return ["JPA / Hibernate", "Spring Data JDBC", "JDBC"];
	if (fw(end, "DotNetMaui")) return ["SQLite-net", "EF Core"];
	if (is(end, "dotnet")) return ["EF Core", "Dapper", "ADO.NET"];
	if (fw(end, "Swift")) return ["SwiftData", "Core Data", "GRDB"];
	if (fw(end, "Flutter")) return ["Drift", "sqflite"];
	if (fw(end, "ReactNative")) return ["expo-sqlite", "WatermelonDB"];
	if (fw(end, "Ionic")) return ["Capacitor SQLite"];
	if (fw(end, "Qt")) return ["Qt SQL"];
	if (fw(end, "Electron")) return ["better-sqlite3", "Prisma"];
	if (is(end, "node")) return ["Prisma", "Drizzle", "TypeORM", "Knex"];
	if (is(end, "go")) return ["database/sql", "GORM", "sqlc"];
	if (fw(end, "Tauri")) return ["SQLx", "rusqlite"];
	if (is(end, "rust")) return ["SQLx", "Diesel", "SeaORM"];
	if (fw(end, "Laravel")) return ["Eloquent"];
	if (is(end, "php")) return ["Doctrine"];
	if (is(end, "ruby")) return ["Active Record"];
	return ["ORM"];
}

function mongoAccess(end: EndInfo): Option[] {
	if (is(end, "dotnet")) return ["MongoDB .NET Driver"];
	if (is(end, "node")) return ["Mongoose", "MongoDB Node.js Driver"];
	if (is(end, "python")) return ["PyMongo", "Motor"];
	if (is(end, "jvm")) return ["Spring Data MongoDB"];
	if (fw(end, "Laravel")) return ["Laravel MongoDB"];
	if (is(end, "ruby")) return ["Mongoid"];
	return [{ en: "MongoDB driver", fr: "Pilote MongoDB" }];
}

function redisAccess(end: EndInfo): Option[] {
	if (is(end, "dotnet")) return ["StackExchange.Redis", "IDistributedCache", "HybridCache"];
	if (is(end, "node")) return ["ioredis"];
	if (is(end, "python")) return ["redis-py"];
	if (is(end, "jvm")) return ["Spring Data Redis", "Lettuce"];
	if (fw(end, "Laravel")) return ["Laravel Cache"];
	if (is(end, "ruby")) return ["Rails.cache"];
	return [];
}

/** Messaging libraries a stack usually wraps its broker in. */
function messagingLibs(end: EndInfo, broker: EndInfo): Option[] {
	if (is(end, "dotnet")) {
		return fw(broker, "AzureServiceBus")
			? ["MassTransit", "Azure.Messaging.ServiceBus", "NServiceBus"]
			: ["MassTransit", "NServiceBus", "Wolverine"];
	}
	if (fw(end, "Quarkus")) return ["SmallRye Reactive Messaging"];
	if (is(end, "jvm")) {
		if (fw(broker, "Kafka")) return ["Spring Kafka", "Spring Cloud Stream"];
		if (fw(broker, "RabbitMq")) return ["Spring AMQP", "Spring Cloud Stream"];
		return ["Spring Cloud Stream"];
	}
	if (fw(end, "Celery")) return ["Celery"];
	if (fw(end, "BullMQ")) return ["BullMQ"];
	if (fw(end, "Sidekiq")) return ["Sidekiq"];
	if (fw(end, "Laravel")) return ["Laravel Queue"];
	if (fw(end, "Symfony")) return ["Symfony Messenger"];
	if (fw(end, "Rails")) return ["Active Job"];
	if (is(end, "node")) return fw(broker, "Kafka") ? ["KafkaJS"] : ["amqplib"];
	if (is(end, "python")) return fw(broker, "Kafka") ? ["aiokafka"] : ["aio-pika"];
	return [];
}

/** The wire protocol of a queue or broker, from its stack. */
function brokerProtocol(broker: EndInfo): Option[] {
	if (fw(broker, "RabbitMq")) return ["AMQP 0-9-1"];
	if (fw(broker, "Kafka")) return [{ en: "Kafka protocol", fr: "Protocole Kafka" }];
	if (fw(broker, "Sqs")) return ["AWS SDK (SQS)"];
	if (fw(broker, "AzureServiceBus")) return ["AMQP 1.0 (Azure Service Bus)"];
	if (fw(broker, "Nats")) return ["NATS"];
	return ["AMQP", { en: "Kafka protocol", fr: "Protocole Kafka" }, "MQTT"];
}

/** How a background worker of this stack is handed a job. */
function jobTriggers(worker: EndInfo, caller: EndInfo): Option[] {
	if (fw(worker, "Celery")) return ["Celery task"];
	if (fw(worker, "BullMQ")) return ["BullMQ job"];
	if (fw(worker, "Sidekiq")) return ["Sidekiq job"];
	if (fw(worker, "Temporal")) return ["Temporal workflow"];
	if (is(worker, "dotnet")) {
		const both = is(caller, "dotnet");
		return [
			...(both ? (["MassTransit"] as Option[]) : []),
			"Hangfire",
			...(both
				? ([{ en: "Channel<T> (in-process)", fr: "Channel<T> (même processus)" }] as Option[])
				: []),
		];
	}
	if (is(worker, "jvm")) return ["Spring Batch", "Quartz"];
	if (is(worker, "python")) return ["Celery task", "RQ"];
	if (is(worker, "node")) return ["BullMQ job"];
	if (is(worker, "ruby")) return ["Sidekiq job"];
	if (fw(worker, "Laravel")) return ["Laravel Queue"];
	return [];
}

/** Real-time push from a server of this stack. */
function realtimeFrom(server: EndInfo): Option[] {
	if (is(server, "dotnet")) return ["SignalR"];
	if (is(server, "node")) return ["Socket.IO"];
	if (fw(server, "Rails")) return ["Action Cable"];
	if (fw(server, "Laravel")) return ["Laravel Reverb"];
	if (fw(server, "Django")) return ["Django Channels"];
	if (is(server, "jvm")) return ["STOMP over WebSocket"];
	return [];
}

function pushToClient(client: EndInfo): Option[] {
	if (client.type === "mobile") return ["FCM / APNs"];
	if (client.type === "desktop")
		return [{ en: "Native notifications", fr: "Notifications natives" }];
	return ["Web Push"];
}

// ── The table ───────────────────────────────────────────────────────────────

type Builder = (src: EndInfo, tgt: EndInfo) => Option[];

const BUILDERS: Record<InteractionKind, Builder> = {
	api: (src, tgt) => {
		const browser = src.type === "frontend";
		return [
			REST,
			GRAPHQL,
			browser ? "gRPC-Web" : GRPC,
			...(is(tgt, "dotnet") || is(src, "dotnet") ? ["SignalR"] : []),
			...(is(src, "ts") && is(tgt, "node") ? ["tRPC"] : []),
			WS,
			SSE,
			...realtimeFrom(tgt).filter((p) => p !== "SignalR"),
			...(src.type === "desktop" ? ["SOAP"] : []),
		];
	},
	serviceCall: (src, tgt) => [
		REST,
		GRPC,
		GRAPHQL,
		...(is(src, "ts") && is(tgt, "node") ? ["tRPC"] : []),
		...(is(src, "go") || is(tgt, "go") ? ["Connect RPC"] : []),
		...(is(src, "dotnet") && is(tgt, "dotnet") ? ["SignalR"] : []),
		WS,
		...(is(src, "dotnet") ? ["Refit", "Dapr"] : ["Dapr"]),
	],
	route: (_src, tgt) =>
		tgt.type === "frontend"
			? [{ en: "HTTP (static files)", fr: "HTTP (fichiers statiques)" }, REST]
			: [
					{ en: "HTTP / REST (reverse proxy)", fr: "HTTP / REST (proxy inverse)" },
					GRPC,
					WS,
					GRAPHQL,
				],
	job: (src, tgt) => [
		...jobTriggers(tgt, src),
		QUEUE,
		GRPC,
		REST,
		{ en: "Scheduled (cron)", fr: "Planifié (cron)" },
	],
	data: (src, tgt) => {
		if (fw(tgt, "MongoDb")) return mongoAccess(src);
		if (fw(tgt, "Redis")) return ["RESP (Redis)", ...redisAccess(src)];
		return [...sqlAccess(src), SQL];
	},
	localData: (src) => [...sqlAccess(src), "SQLite"],
	cache: (src, tgt) => [
		...(fw(tgt, "Memcached") ? ["Memcached"] : ["RESP (Redis)"]),
		...redisAccess(src),
	],
	search: (src, tgt) => [
		REST,
		...(fw(tgt, "Elasticsearch", "OpenSearch") ? ["Query DSL"] : []),
		...(is(src, "dotnet") && fw(tgt, "Elasticsearch") ? ["Elastic .NET client"] : []),
		...(is(src, "jvm") && fw(tgt, "Elasticsearch", "OpenSearch")
			? ["Spring Data Elasticsearch"]
			: []),
		...(fw(src, "Laravel") ? ["Laravel Scout"] : []),
		...(fw(src, "Rails") ? ["Searchkick"] : []),
	],
	searchClient: () => [REST, "InstantSearch"],
	publish: (src, tgt) => [
		...brokerProtocol(tgt),
		...messagingLibs(src, tgt),
		...(src.type === "backend" || src.type === "microservice"
			? [{ en: "Transactional outbox", fr: "Outbox transactionnel" } as Option]
			: []),
	],
	consume: (src, tgt) => [...brokerProtocol(src), ...messagingLibs(tgt, src)],
	storage: (src, tgt) => {
		if (fw(tgt, "LocalDisk")) return [{ en: "File system", fr: "Système de fichiers" }];
		if (fw(tgt, "AzureBlob")) return ["Azure Blob SDK"];
		return [
			"S3 API",
			...(is(src, "dotnet") ? ["Azure Blob SDK"] : []),
			...(fw(src, "Laravel") ? ["Flysystem"] : []),
			...(fw(src, "Rails") ? ["Active Storage"] : []),
		];
	},
	storageClient: (_src, tgt) => [
		fw(tgt, "AzureBlob")
			? { en: "SAS URL (HTTPS)", fr: "URL SAS (HTTPS)" }
			: { en: "Presigned URL (HTTPS)", fr: "URL pré-signée (HTTPS)" },
		...(fw(tgt, "AzureBlob") ? [] : ["S3 API"]),
	],
	thirdparty: (src) => [
		REST,
		SDK,
		GRAPHQL,
		...(src.type === "frontend" ? [] : [GRPC, "SOAP"]),
	],
	webhook: () => [{ en: "Webhook (HTTP POST)", fr: "Webhook (HTTP POST)" }, WS, SSE],
	authClient: (src, tgt) => [
		{ en: "OIDC (code + PKCE)", fr: "OIDC (code + PKCE)" },
		"OAuth 2.0",
		...(fw(tgt, "EntraId") || is(src, "dotnet") ? ["MSAL"] : []),
		...(fw(tgt, "Auth0") ? ["Auth0 SDK"] : []),
		...(fw(tgt, "Keycloak") && src.type === "frontend" ? ["keycloak-js"] : []),
		"JWT",
		"SAML 2.0",
		...(src.type === "frontend" ? [{ en: "Session cookie", fr: "Cookie de session" }] : []),
	],
	authServer: (src) => [
		"JWT (JWKS)",
		{ en: "Token introspection", fr: "Introspection de jeton" },
		"OIDC",
		...(is(src, "dotnet") ? ["JwtBearer (ASP.NET Core)"] : []),
		...(is(src, "jvm") ? ["Spring Security OAuth2"] : []),
		{ en: "API key", fr: "Clé d'API" },
		"mTLS",
	],
	authMachine: () => [
		{ en: "OAuth 2.0 client credentials", fr: "OAuth 2.0 client credentials" },
		"mTLS",
		{ en: "API key", fr: "Clé d'API" },
	],
	federation: () => ["OIDC", "SAML 2.0", "LDAP"],
	notify: (_src, tgt) => {
		if (fw(tgt, "SendGrid")) return ["SendGrid API", "SMTP"];
		if (fw(tgt, "Twilio")) return ["Twilio API"];
		if (fw(tgt, "Smtp")) return ["SMTP"];
		if (fw(tgt, "Firebase")) return ["FCM"];
		return [REST, "SMTP", "FCM / APNs"];
	},
	push: (src, tgt) => {
		// Towards a client: the real-time channel of the server's stack, or the
		// platform's push service when it is a notification block.
		if (src.type === "notification") return [...pushToClient(tgt), WS, SSE];
		return [
			...realtimeFrom(src),
			WS,
			SSE,
			...(tgt.type === "mobile" ? ["FCM / APNs"] : []),
		];
	},
	telemetry: (src, tgt) => {
		const first: Option[] = fw(tgt, "Prometheus")
			? [{ en: "Prometheus scrape (/metrics)", fr: "Scrape Prometheus (/metrics)" }]
			: fw(tgt, "AppInsights")
				? ["Application Insights SDK", "Azure Monitor OpenTelemetry"]
				: fw(tgt, "Datadog")
					? ["Datadog Agent"]
					: [];
		const client = ["frontend", "mobile", "desktop"].includes(src.type ?? "");
		return [
			...first,
			OTLP,
			...(client ? [{ en: "RUM SDK", fr: "SDK RUM" } as Option] : []),
			...(is(src, "dotnet") && !first.length ? ["Serilog"] : []),
			{ en: "Logs (stdout)", fr: "Logs (stdout)" },
		];
	},
	analytics: (src, tgt) => {
		if (fw(tgt, "PostHog")) return ["PostHog SDK", REST];
		if (fw(tgt, "Matomo")) return ["Matomo Tracking API"];
		if (fw(tgt, "GoogleAnalytics"))
			return src.type === "frontend" ? ["GA4 (gtag.js)"] : ["GA4 Measurement Protocol"];
		return [SDK, REST];
	},
	assets: () => ["HTTPS", "HTTP/3"],
	origin: () => [{ en: "HTTPS (origin pull)", fr: "HTTPS (origin pull)" }],
	purge: () => [{ en: "Purge API", fr: "API de purge" }, { en: "Cache tags", fr: "Tags de cache" }],
	microfrontend: () => ["Module Federation", "Web Components", "iframe"],
	cdc: (src, tgt) => [
		"CDC (Debezium)",
		{ en: "Transactional outbox", fr: "Outbox transactionnel" },
		...(fw(src, "Postgres") ? [{ en: "Logical replication", fr: "Réplication logique" } as Option] : []),
		...(fw(src, "SqlServer") ? ["SQL Server CDC"] : []),
		...(fw(src, "MongoDb") ? ["Change Streams"] : []),
		...(fw(tgt, "Kafka") ? ["Kafka Connect"] : []),
	],
	replication: (src) => [
		...(fw(src, "Postgres") ? [{ en: "Streaming replication", fr: "Réplication en streaming" } as Option] : []),
		...(fw(src, "MySql") ? [{ en: "Binlog replication", fr: "Réplication binlog" } as Option] : []),
		...(fw(src, "SqlServer") ? ["Always On"] : []),
		...(fw(src, "MongoDb") ? ["Replica set"] : []),
		{ en: "Primary → replica", fr: "Primaire → réplica" },
	],
	brokerRoute: (src) => [
		...(fw(src, "RabbitMq") ? [{ en: "Exchange binding", fr: "Liaison d'exchange" } as Option] : []),
		...(fw(src, "AzureServiceBus") ? [{ en: "Topic subscription", fr: "Abonnement au topic" } as Option] : []),
		...(fw(src, "Kafka") ? ["Kafka Connect"] : []),
		{ en: "Topic → queue", fr: "Topic → file" },
	],
	brokerMirror: (src) => [
		...(fw(src, "Kafka") ? ["MirrorMaker 2"] : []),
		...(fw(src, "RabbitMq") ? ["Shovel / Federation"] : []),
		...(fw(src, "Nats") ? [{ en: "Leaf node", fr: "Nœud feuille" } as Option] : []),
		{ en: "Replication", fr: "Réplication" },
	],
	deadLetter: () => [
		{ en: "Dead-letter queue", fr: "File de lettres mortes" },
		{ en: "Retry queue", fr: "File de réessai" },
	],
	objectEvents: (src) => [
		...(fw(src, "S3", "MinIo") ? ["S3 Event Notifications"] : []),
		...(fw(src, "AzureBlob") ? ["Event Grid"] : []),
		{ en: "Object events", fr: "Événements d'objets" },
	],
	alerting: (src) => [
		...(fw(src, "Prometheus") ? ["Alertmanager"] : []),
		"Webhook",
		{ en: "Email (SMTP)", fr: "E-mail (SMTP)" },
		"PagerDuty / Opsgenie",
	],
	export: () => [
		{ en: "Batch export", fr: "Export par lots" },
		"ETL / ELT",
	],
	generic: () => [REST, GRPC, GRAPHQL, WS, QUEUE, SDK],
};

function spell(o: Option, lang: Lang): string {
	return typeof o === "string" ? o : o[lang];
}

/**
 * The relations to offer for one kind of interaction between two blocks,
 * localized, most usual first, without duplicates.
 */
export function protocolsFor(
	kind: InteractionKind,
	src: EndInfo,
	tgt: EndInfo,
	lang: Lang = "en",
): string[] {
	return [...new Set(BUILDERS[kind](src, tgt).map((o) => spell(o, lang)))];
}
