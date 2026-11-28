/**
 * What the registry and OSV say of an MCP Marketplace server's package (#369).
 *
 * Only for a catalog entry (the catalog ships with the app): the renderer
 * names a server id, never a package or a URL, so the hosts read here are a
 * closed list (registry.npmjs.org, pypi.org, api.osv.dev). Each read is
 * bounded in time and size, and what it returns is data: a name, a date, a
 * list of advisories, shown to the person and never run.
 *
 * The maintainers seen the first time a package is checked on this machine
 * are kept: a later check that finds someone new raises « maintainer
 * changed », the sign of an account takeover. Reads are cached a day.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { McpMarketplaceServer } from "../../shared/types/mcp-marketplace";
import type {
	McpKnownVulnerability,
	McpRegistryFacts,
} from "../../shared/types/mcp-security";

export const CACHE_TTL_MS = 86_400_000;
export const TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_VULNERABILITIES = 20;
const MAX_TEXT = 200;

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION = /^\d+\.\d+(\.\d+)?$/;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PackageRef {
	ecosystem: "npm" | "PyPI";
	name: string;
	/** The version the launch arguments pin, if any. */
	version?: string;
}

/** The package a stdio catalog entry starts, or null (remote, unknown launcher). */
export function packageOf(entry: McpMarketplaceServer): PackageRef | null {
	if (entry.transport !== "stdio") return null;
	const ecosystem =
		entry.command === "npx" ? "npm" : entry.command === "uvx" ? "PyPI" : null;
	if (!ecosystem) return null;
	const name = entry.package;
	if (!(ecosystem === "npm" ? NPM_NAME : PYPI_NAME).test(name)) return null;
	const separator = ecosystem === "npm" ? "@" : "==";
	const pinned = (entry.args ?? [])
		.filter((arg) => arg.startsWith(name + separator))
		.map((arg) => arg.slice(name.length + separator.length))
		.find((version) => VERSION.test(version));
	return { ecosystem, name, ...(pinned ? { version: pinned } : {}) };
}

export function text(value: unknown, limit = MAX_TEXT): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

export async function readJson(fetcher: Fetcher, url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetcher(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw new Error("response too large");
	const body = await response.text();
	if (body.length > MAX_BODY_BYTES) throw new Error("response too large");
	return JSON.parse(body);
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function repositoryUrl(value: unknown): string {
	return typeof value === "string" ? text(value) : text(record(value).url);
}

interface PackageFacts {
	version?: string;
	lastRelease?: string;
	maintainers: string[];
	repository?: string;
	deprecated?: boolean;
}

async function npmFacts(fetcher: Fetcher, ref: PackageRef): Promise<PackageFacts> {
	const encoded = ref.name.replaceAll("/", "%2F");
	const doc = record(await readJson(fetcher, `https://registry.npmjs.org/${encoded}`));
	const tags = record(doc["dist-tags"]);
	const latest = text(tags.latest);
	const version = ref.version ?? latest;
	const versionDoc = record(record(doc.versions)[version]);
	const times = record(doc.time);
	const maintainers = (Array.isArray(doc.maintainers) ? doc.maintainers : [])
		.map((m) => text(record(m).name) || text(m))
		.filter(Boolean)
		.sort();
	const repository = repositoryUrl(versionDoc.repository) || repositoryUrl(doc.repository);
	return {
		version,
		lastRelease: text(times[latest]) || undefined,
		maintainers,
		repository: repository || undefined,
		deprecated: Boolean(versionDoc.deprecated),
	};
}

const SOURCE_HOST = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i;

async function pypiFacts(fetcher: Fetcher, ref: PackageRef): Promise<PackageFacts> {
	const url = ref.version
		? `https://pypi.org/pypi/${ref.name}/${ref.version}/json`
		: `https://pypi.org/pypi/${ref.name}/json`;
	const doc = record(await readJson(fetcher, url));
	const info = record(doc.info);
	const files = Array.isArray(doc.urls) ? doc.urls : [];
	const uploads = files
		.map((f) => text(record(f).upload_time_iso_8601))
		.filter(Boolean)
		.sort();
	const links = [
		...Object.values(record(info.project_urls)),
		info.home_page,
	].map((v) => text(v));
	const maintainers = [text(info.maintainer), text(info.author)]
		.filter(Boolean)
		.filter((name, i, all) => all.indexOf(name) === i)
		.sort();
	return {
		version: text(info.version) || ref.version,
		lastRelease: uploads.at(-1),
		maintainers,
		repository: links.find((link) => SOURCE_HOST.test(link)),
		deprecated: Boolean(info.yanked),
	};
}

async function osvVulnerabilities(
	fetcher: Fetcher,
	ref: PackageRef,
	version: string | undefined,
): Promise<McpKnownVulnerability[]> {
	const query = {
		package: { name: ref.name, ecosystem: ref.ecosystem },
		...(version ? { version } : {}),
	};
	const doc = record(
		await readJson(fetcher, "https://api.osv.dev/v1/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(query),
		}),
	);
	const vulns = Array.isArray(doc.vulns) ? doc.vulns : [];
	return vulns.slice(0, MAX_VULNERABILITIES).map((v) => ({
		id: text(record(v).id, 60),
		summary: text(record(v).summary),
	}));
}

interface CacheEntry {
	facts: McpRegistryFacts;
}

type Cache = Record<string, CacheEntry>;

export class RegistryFactsStore {
	constructor(
		private readonly file: string,
		private readonly fetcher: Fetcher = fetch,
		private readonly now: () => number = Date.now,
	) {}

	private read(): Cache {
		try {
			return record(JSON.parse(fs.readFileSync(this.file, "utf-8"))) as Cache;
		} catch {
			return {};
		}
	}

	private write(cache: Cache): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(cache, null, 2), "utf-8");
	}

	/** The last facts read for this server, without any network. */
	cached(serverId: string): McpRegistryFacts | undefined {
		return this.read()[serverId]?.facts;
	}

	/** Fresh facts (or the cached ones under a day old); throws when unreachable. */
	async facts(
		serverId: string,
		ref: PackageRef,
		refresh = false,
	): Promise<McpRegistryFacts> {
		const cache = this.read();
		const known = cache[serverId]?.facts;
		const age = known ? this.now() - Date.parse(known.checkedAt) : Number.POSITIVE_INFINITY;
		if (known && !refresh && age < CACHE_TTL_MS) return known;

		const pkg = ref.ecosystem === "npm"
			? await npmFacts(this.fetcher, ref)
			: await pypiFacts(this.fetcher, ref);
		let vulnerabilities: McpKnownVulnerability[] = [];
		let vulnerabilitiesUnknown = false;
		try {
			vulnerabilities = await osvVulnerabilities(this.fetcher, ref, pkg.version);
		} catch {
			vulnerabilitiesUnknown = true;
		}
		const facts: McpRegistryFacts = {
			ecosystem: ref.ecosystem,
			...pkg,
			firstSeenMaintainers: known?.firstSeenMaintainers.length
				? known.firstSeenMaintainers
				: pkg.maintainers,
			vulnerabilities,
			...(vulnerabilitiesUnknown ? { vulnerabilitiesUnknown } : {}),
			checkedAt: new Date(this.now()).toISOString(),
		};
		cache[serverId] = { facts };
		this.write(cache);
		return facts;
	}
}
