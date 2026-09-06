/**
 * architecture-blocks — the single catalogue of canvas block types.
 *
 * Before this file the palette owned an emoji per type and the node renderer
 * owned nothing: a block dragged onto the canvas lost every visual clue about
 * what it was, and the two lists could not drift apart because only one of
 * them existed. Emoji were also the wrong carrier — they render as tofu boxes
 * on any machine without a colour-emoji font, which is most Linux desktops.
 *
 * Everything visual about a type now lives here (icon, accent, category) plus
 * the stacks that type can be built with, so the palette, the node, the
 * inspector and the framework dialog all answer from the same table.
 *
 * Pure and React-free apart from the icon components, so it is unit testable.
 */

import {
	Bell,
	Blocks,
	ChartNoAxesCombined,
	Cloud,
	Container,
	Cpu,
	Database,
	Gauge,
	HardDrive,
	Inbox,
	KeyRound,
	Layers,
	type LucideIcon,
	Monitor,
	MonitorSmartphone,
	Radio,
	Search,
	Server,
	Share2,
	ShieldCheck,
} from "lucide-react";

export interface BlockMeta {
	/** Stable id stored on the node as `data.type`. Never translate this. */
	type: string;
	labelKey: string;
	descKey: string;
	icon: LucideIcon;
	/** Hex accent, tinted at render time so it works in light and dark. */
	accent: string;
}

export interface BlockCategory {
	labelKey: string;
	blocks: BlockMeta[];
}

export const BLOCK_CATEGORIES: BlockCategory[] = [
	{
		labelKey: "categoryFrontend",
		blocks: [
			{
				type: "frontend",
				labelKey: "frontend",
				descKey: "frontendDesc",
				icon: Monitor,
				accent: "#3b82f6",
			},
			{
				type: "desktop",
				labelKey: "desktop",
				descKey: "desktopDesc",
				icon: MonitorSmartphone,
				accent: "#0ea5e9",
			},
		],
	},
	{
		labelKey: "categoryBackend",
		blocks: [
			{
				type: "backend",
				labelKey: "backend",
				descKey: "backendDesc",
				icon: Server,
				accent: "#8b5cf6",
			},
			{
				type: "worker",
				labelKey: "worker",
				descKey: "workerDesc",
				icon: Cpu,
				accent: "#a855f7",
			},
			{
				type: "microservice",
				labelKey: "microservice",
				descKey: "microserviceDesc",
				icon: Container,
				accent: "#7c3aed",
			},
			{
				type: "gateway",
				labelKey: "gateway",
				descKey: "gatewayDesc",
				icon: Share2,
				accent: "#6366f1",
			},
		],
	},
	{
		labelKey: "categoryData",
		blocks: [
			{
				type: "database",
				labelKey: "database",
				descKey: "databaseDesc",
				icon: Database,
				accent: "#10b981",
			},
			{
				type: "cache",
				labelKey: "cache",
				descKey: "cacheDesc",
				icon: Layers,
				accent: "#14b8a6",
			},
			{
				type: "search",
				labelKey: "search",
				descKey: "searchDesc",
				icon: Search,
				accent: "#059669",
			},
			{
				type: "queue",
				labelKey: "queue",
				descKey: "queueDesc",
				icon: Inbox,
				accent: "#f59e0b",
			},
			{
				type: "storage",
				labelKey: "storage",
				descKey: "storageDesc",
				icon: HardDrive,
				accent: "#84cc16",
			},
		],
	},
	{
		labelKey: "categoryInfra",
		blocks: [
			{
				type: "messagebroker",
				labelKey: "messageBroker",
				descKey: "messageBrokerDesc",
				icon: Radio,
				accent: "#f97316",
			},
			{
				type: "cdn",
				labelKey: "cdn",
				descKey: "cdnDesc",
				icon: Cloud,
				accent: "#0891b2",
			},
			{
				type: "monitoring",
				labelKey: "monitoring",
				descKey: "monitoringDesc",
				icon: Gauge,
				accent: "#ec4899",
			},
			{
				type: "analytics",
				labelKey: "analytics",
				descKey: "analyticsDesc",
				icon: ChartNoAxesCombined,
				accent: "#d946ef",
			},
		],
	},
	{
		labelKey: "categorySecurity",
		blocks: [
			{
				type: "auth",
				labelKey: "auth",
				descKey: "authDesc",
				icon: ShieldCheck,
				accent: "#ef4444",
			},
		],
	},
	{
		labelKey: "categoryIntegration",
		blocks: [
			{
				type: "thirdparty",
				labelKey: "thirdPartyApi",
				descKey: "thirdPartyApiDesc",
				icon: KeyRound,
				accent: "#eab308",
			},
			{
				type: "notification",
				labelKey: "notification",
				descKey: "notificationDesc",
				icon: Bell,
				accent: "#f43f5e",
			},
		],
	},
	{
		labelKey: "categoryCustom",
		blocks: [
			{
				type: "custom",
				labelKey: "customBlock",
				descKey: "customBlockDesc",
				icon: Blocks,
				accent: "#64748b",
			},
		],
	},
];

const BY_TYPE: Record<string, BlockMeta> = Object.fromEntries(
	BLOCK_CATEGORIES.flatMap((c) => c.blocks).map((b) => [b.type, b]),
);

/** Metadata for a node's `data.type`, or `undefined` for an untyped node. */
export function blockMeta(type?: string): BlockMeta | undefined {
	return type ? BY_TYPE[type] : undefined;
}

/** Accent colour for a type, falling back to the neutral custom accent. */
export function blockAccent(type?: string): string {
	return blockMeta(type)?.accent ?? "#64748b";
}

/**
 * Stacks offered for a block type. A type absent from this table is created
 * straight away instead of opening the technology dialog — asking "which
 * framework?" about a Redis cache has no useful answer.
 */
export const FRAMEWORKS_BY_TYPE: Record<string, string[]> = {
	frontend: ["React", "Angular", "Vue", "Svelte", "NextJs", "Blazor"],
	desktop: [
		"WPF",
		"WinForms",
		"WinUI",
		"DotNetMaui",
		"Avalonia",
		"Electron",
		"Qt",
	],
	backend: [
		"DotNet",
		"NodeJs",
		"Python",
		"Django",
		"Flask",
		"Spring",
		"Go",
		"Rust",
	],
	microservice: ["DotNet", "NodeJs", "Python", "Spring", "Go", "Rust"],
	worker: ["DotNet", "Celery", "BullMQ", "Sidekiq", "Temporal"],
	gateway: ["Nginx", "Kong", "Traefik", "YARP", "ApiGateway"],
	database: ["Postgres", "MySql", "MongoDb", "Sqlite", "SqlServer", "Redis"],
	cache: ["Redis", "Memcached", "Valkey"],
	search: ["Elasticsearch", "Meilisearch", "OpenSearch", "Typesense"],
	queue: ["RabbitMq", "Kafka", "Sqs", "AzureServiceBus"],
	messagebroker: ["RabbitMq", "Kafka", "Nats", "AzureServiceBus"],
	storage: ["S3", "MinIo", "AzureBlob", "LocalDisk"],
	cdn: ["Cloudflare", "Akamai", "AzureCdn", "Fastly"],
	monitoring: ["Prometheus", "Grafana", "AppInsights", "Datadog"],
	analytics: ["Matomo", "PostHog", "GoogleAnalytics"],
	auth: ["Jwt", "OAuth2", "Auth0", "Keycloak", "EntraId"],
	notification: ["SendGrid", "Twilio", "Smtp", "Firebase"],
};

/** Whether creating this type should ask for a technology first. */
export function needsFramework(type: string): boolean {
	return (FRAMEWORKS_BY_TYPE[type]?.length ?? 0) > 0;
}

/** Fold accents and case so "donnees" matches "Données". */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim();
}

/**
 * Filter the catalogue against a free-text query, matching the *translated*
 * label and description as well as the raw type id. Categories that end up
 * empty are dropped, so the palette never renders a heading over nothing.
 *
 * `resolve` is the caller's i18n lookup, kept as a parameter so this stays a
 * pure function.
 */
export function filterBlocks(
	query: string,
	resolve: (key: string) => string,
	categories: BlockCategory[] = BLOCK_CATEGORIES,
): BlockCategory[] {
	const q = normalize(query);
	if (!q) return categories;
	return categories
		.map((cat) => ({
			...cat,
			blocks: cat.blocks.filter((b) =>
				[b.type, resolve(b.labelKey), resolve(b.descKey), resolve(cat.labelKey)]
					.map(normalize)
					.some((hay) => hay.includes(q)),
			),
		}))
		.filter((cat) => cat.blocks.length > 0);
}
