import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile, walkFiles } from "./source-files";
import { specDialect } from "./spec-files";

/**
 * Fetching the description from the application while it runs.
 *
 * This is the second of three sources, between a spec committed to the
 * repository and the source scan. It is exact — the framework generated it
 * from the routes it actually registered — but only when the app happens to
 * be running, so nothing here may fail loudly or take long: it is a fallback,
 * and a fallback that hangs is worse than one that finds nothing.
 */

export interface LiveSpec {
	url: string;
	document: Record<string, unknown>;
	dialect: "openapi3" | "swagger2";
	pathCount: number;
}

/** Conventional spec endpoints, per framework and in order of likelihood. */
const SPEC_PATHS_BY_FRAMEWORK: Record<string, string[]> = {
	"ASP.NET Core": [
		"/swagger/v1/swagger.json",
		"/openapi/v1.json",
		"/swagger.json",
	],
	"Spring Boot": ["/v3/api-docs", "/v2/api-docs"],
	FastAPI: ["/openapi.json"],
	Flask: ["/openapi.json", "/apispec_1.json", "/swagger.json"],
	NestJS: ["/api-docs-json", "/api/docs-json", "/swagger-json"],
	Express: ["/openapi.json", "/swagger.json", "/api-docs.json"],
	Go: ["/swagger/doc.json", "/openapi.json", "/swagger.json"],
	"Rust/Axum": ["/api-docs/openapi.json", "/openapi.json"],
	"Rust/Actix": ["/api-docs/openapi.json", "/openapi.json"],
	Rails: ["/api-docs/v1/swagger.json", "/openapi.json"],
};

/** Tried for every project: the endpoints that are not framework-specific. */
const GENERIC_SPEC_PATHS = [
	"/openapi.json",
	"/swagger.json",
	"/v3/api-docs",
	"/api-docs",
	"/openapi.yaml",
];

/** Where a framework listens when nothing in the project says otherwise. */
const DEFAULT_PORTS_BY_FRAMEWORK: Record<string, number[]> = {
	"ASP.NET Core": [5000, 5001],
	"Spring Boot": [8080],
	FastAPI: [8000],
	Flask: [5000],
	NestJS: [3000],
	Express: [3000],
	Go: [8080],
	"Rust/Axum": [3000],
	"Rust/Actix": [8080],
	Rails: [3000],
};

/** Ceilings that keep a fallback from turning into a wait. */
export interface ProbeLimits {
	/** Requests attempted at all, however many candidates were discovered. */
	maxUrls: number;
	/** A server that has not answered by then is not the one we are after. */
	requestTimeoutMs: number;
	/** Total time the whole probe may take, across every attempt. */
	totalBudgetMs: number;
	/** Requests in flight at once. */
	concurrency: number;
}

export const PROBE_LIMITS: ProbeLimits = {
	maxUrls: 24,
	requestTimeoutMs: 2000,
	totalBudgetMs: 8000,
	concurrency: 6,
};

function portsFromText(text: string, patterns: RegExp[]): number[] {
	const ports: number[] = [];
	for (const pattern of patterns) {
		const flags = pattern.flags.includes("g")
			? pattern.flags
			: `${pattern.flags}g`;
		const re = new RegExp(pattern.source, flags);
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = re.exec(text)) !== null) {
			const port = Number.parseInt(match[1], 10);
			if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
		}
	}
	return ports;
}

/**
 * Base URLs the project's own configuration points at.
 *
 * Every entry is evidence read from a file the team wrote — a launch profile,
 * a Spring property, a compose mapping, a `PORT` in an env file. Framework
 * defaults come last, so a configured port is always tried first.
 */
/** The origin of `url`, when it points at this machine — otherwise nothing. */
function loopbackOrigin(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase();
	const local =
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "0.0.0.0" ||
		host === "::1" ||
		host === "[::1]";
	return local ? parsed.origin : undefined;
}

export function discoverBaseUrls(
	projectPath: string,
	frameworks: string[],
): string[] {
	const urls: string[] = [];
	const push = (url: string) => {
		const trimmed = url.trim().replace(/\/+$/, "");
		if (/^https?:\/\/\S+$/.test(trimmed) && !urls.includes(trimmed)) {
			urls.push(trimmed);
		}
	};
	const pushPort = (port: number) => push(`http://127.0.0.1:${port}`);

	// .NET launch profiles state the URLs outright, https included.
	for (const file of walkFiles(projectPath, ["launchSettings.json"], 6)) {
		const content = readFile(file);
		if (!content) continue;
		try {
			const parsed = JSON.parse(content) as {
				profiles?: Record<string, { applicationUrl?: string }>;
			};
			for (const profile of Object.values(parsed.profiles ?? {})) {
				for (const url of profile.applicationUrl?.split(";") ?? []) push(url);
			}
		} catch {
			// A malformed launch profile costs one source, not the probe.
		}
	}

	// `Rag.Api.http` — the request file the .NET templates scaffold next to the
	// project. Its `@HostAddress` is the address the developer actually calls.
	// Only loopback is kept: a request file may well name the production API,
	// and the probe must not reach for it.
	for (const file of walkFiles(projectPath, [".http", ".rest"], 6)) {
		const content = readFile(file);
		if (!content) continue;
		for (const match of content.matchAll(/https?:\/\/[^\s"'{}<>]+/g)) {
			const origin = loopbackOrigin(match[0]);
			if (origin) push(origin);
		}
	}

	const configFiles = walkFiles(
		projectPath,
		[
			"application.properties",
			"application.yml",
			"application.yaml",
			".env",
			".env.local",
			".env.development",
			"docker-compose.yml",
			"docker-compose.yaml",
			"compose.yml",
			"compose.yaml",
			"package.json",
			"Procfile",
		],
		4,
	);

	for (const file of configFiles) {
		const content = readFile(file);
		if (!content) continue;
		const base = path.basename(file).toLowerCase();

		if (base === "package.json") {
			// Only the scripts: a dependency version must not be read as a port.
			let scripts = "";
			try {
				const parsed = JSON.parse(content) as {
					scripts?: Record<string, string>;
				};
				scripts = Object.values(parsed.scripts ?? {}).join("\n");
			} catch {
				continue;
			}
			for (const port of portsFromText(scripts, [
				/--port[= ](\d{2,5})/,
				/\bPORT=(\d{2,5})/,
			])) {
				pushPort(port);
			}
			continue;
		}

		if (base.startsWith("docker-compose") || base.startsWith("compose")) {
			// "8081:8080" — the host side is the one reachable from here.
			for (const port of portsFromText(content, [
				/["'\s-]\s*(\d{2,5}):\d{2,5}["'\s]/,
			])) {
				pushPort(port);
			}
			continue;
		}

		for (const port of portsFromText(content, [
			/^\s*server\.port\s*[:=]\s*(\d{2,5})/m,
			/^\s{0,8}port\s*:\s*(\d{2,5})/m,
			/^\s*PORT\s*=\s*(\d{2,5})/m,
			/--port[= ](\d{2,5})/,
		])) {
			pushPort(port);
		}
	}

	for (const framework of frameworks) {
		for (const port of DEFAULT_PORTS_BY_FRAMEWORK[framework] ?? []) {
			pushPort(port);
		}
	}

	return urls;
}

/** The spec endpoints worth trying, most specific first. */
export function specPathsFor(frameworks: string[]): string[] {
	const paths: string[] = [];
	for (const framework of frameworks) {
		for (const specPath of SPEC_PATHS_BY_FRAMEWORK[framework] ?? []) {
			if (!paths.includes(specPath)) paths.push(specPath);
		}
	}
	for (const specPath of GENERIC_SPEC_PATHS) {
		if (!paths.includes(specPath)) paths.push(specPath);
	}
	return paths;
}

/**
 * The URLs to probe, ordered so the most likely comes first and capped so a
 * project with many configured ports cannot become a hundred requests.
 */
export function buildProbeUrls(
	baseUrls: string[],
	frameworks: string[],
	limit: number = PROBE_LIMITS.maxUrls,
): string[] {
	const specPaths = specPathsFor(frameworks);
	const urls: string[] = [];
	// Breadth first over bases: with several candidate ports, the first spec
	// path on each is worth more than the fifth path on the first one.
	for (const specPath of specPaths) {
		for (const base of baseUrls) {
			const url = `${base}${specPath}`;
			if (!urls.includes(url)) urls.push(url);
			if (urls.length >= limit) return urls;
		}
	}
	return urls;
}

/** Reads a body as an API description, whatever it was served as. */
export function parseSpecBody(body: string): Record<string, unknown> | null {
	const text = body.trim();
	if (!text) return null;
	try {
		const parsed = text.startsWith("{")
			? JSON.parse(text)
			: parseYaml(text, { maxAliasCount: 100 });
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export type SpecFetcher = (
	url: string,
	timeoutMs: number,
) => Promise<string | null>;

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/**
 * Asks each candidate in turn, a few at a time, and returns the first URL
 * that answers with something that really is an API description.
 *
 * Ordering survives the parallelism: within a batch the earliest-ranked
 * answer wins, so running six requests at once never changes which spec is
 * chosen. The whole thing stops at the total budget, and every failure —
 * refused connection, timeout, an HTML error page, half a JSON document — is
 * simply not a match.
 */
export async function probeLiveSpec(
	urls: string[],
	fetchSpec: SpecFetcher,
	limits: Partial<ProbeLimits> = {},
): Promise<LiveSpec | null> {
	const { requestTimeoutMs, totalBudgetMs, concurrency } = {
		...PROBE_LIMITS,
		...limits,
	};
	const deadline = Date.now() + totalBudgetMs;

	for (const batch of chunk(urls, concurrency)) {
		if (Date.now() >= deadline) return null;
		const remaining = Math.max(
			1,
			Math.min(requestTimeoutMs, deadline - Date.now()),
		);

		const results = await Promise.all(
			batch.map(async (url): Promise<LiveSpec | null> => {
				let body: string | null;
				try {
					body = await fetchSpec(url, remaining);
				} catch {
					return null;
				}
				if (!body) return null;
				const document = parseSpecBody(body);
				if (!document) return null;
				const dialect = specDialect(document);
				if (!dialect) return null;
				return {
					url,
					document,
					dialect,
					pathCount: Object.keys(document.paths as object).length,
				};
			}),
		);

		const found = results.find((result) => result !== null);
		if (found) return found;
	}

	return null;
}
