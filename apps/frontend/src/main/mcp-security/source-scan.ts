/**
 * The static scan of the code a catalog server runs (issue #369, lot 3).
 *
 * For the version the registry facts name, the main process reads the
 * archive the registry publishes: the npm tarball, or the PyPI sdist (a
 * wheel when there is none). The URL comes from the registry's own answer
 * and must be on its file host (`registry.npmjs.org`,
 * `files.pythonhosted.org`), with no redirect; the bytes are checked against
 * the digest the registry gives before anything is read; the archive is
 * read in memory, bounded (`archive-reader.ts`), never unpacked to disk nor
 * run. The package name is the shipped catalog's, never the renderer's.
 *
 * A published version does not change, so a scan is kept per version and
 * only a new version is read again. What cannot be read (no archive, not
 * found, too large, digest that does not match) is a result: the code that
 * would run cannot be audited. A network failure is not: the caller says
 * « not checked ».
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanSources } from "../../shared/mcp-catalog/code-scan";
import type { McpCodeScan, McpCodeUnavailableReason } from "../../shared/types/mcp-code-scan";
import { type ArchiveError, readTarGz, readZip, type SourceFiles } from "./archive-reader";
import {
	type Fetcher,
	type PackageRef,
	readJson,
	record,
	TIMEOUT_MS,
	text,
} from "./registry-facts";

export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_CACHED = 100;

const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,60})?$/;
const PYPI_VERSION = /^\d[0-9A-Za-z.+!-]{0,60}$/;
const FILE_HOST: Record<PackageRef["ecosystem"], string> = {
	npm: "registry.npmjs.org",
	PyPI: "files.pythonhosted.org",
};

/** The scan cannot read the code, for a reason that is a result. */
class Unavailable extends Error {
	constructor(readonly reason: McpCodeUnavailableReason) {
		super(reason);
	}
}

interface Archive {
	url: string;
	format: "tgz" | "zip";
	/** Digest algorithm (node's name) and its expected value, as the registry gives it. */
	digest: { algorithm: "sha512" | "sha256" | "sha1"; value: Buffer };
}

/** `url` on the registry's own file host, over https, else null. */
export function archiveUrl(raw: unknown, ecosystem: PackageRef["ecosystem"]): string | null {
	if (typeof raw !== "string" || raw.length > 1_000) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
		return url.hostname === FILE_HOST[ecosystem] ? url.href : null;
	} catch {
		return null;
	}
}

async function getJson(fetcher: Fetcher, url: string): Promise<Record<string, unknown>> {
	try {
		return record(await readJson(fetcher, url));
	} catch (error) {
		const status = /^HTTP (\d+)$/.exec(error instanceof Error ? error.message : "");
		if (status && (status[1] === "404" || status[1] === "410")) throw new Unavailable("missing");
		throw error;
	}
}

async function npmArchive(fetcher: Fetcher, ref: PackageRef, version: string): Promise<Archive> {
	const encoded = ref.name.replaceAll("/", "%2F");
	const doc = await getJson(fetcher, `https://registry.npmjs.org/${encoded}/${version}`);
	const dist = record(doc.dist);
	const url = archiveUrl(dist.tarball, "npm");
	if (!url) throw new Unavailable(dist.tarball ? "unsupported" : "noArchive");
	const integrity = text(dist.integrity, 1_000)
		.split(" ")
		.find((part) => part.startsWith("sha512-"));
	if (integrity) {
		return {
			url,
			format: "tgz",
			digest: { algorithm: "sha512", value: Buffer.from(integrity.slice(7), "base64") },
		};
	}
	const shasum = text(dist.shasum);
	if (!/^[0-9a-f]{40}$/i.test(shasum)) throw new Unavailable("integrity");
	return { url, format: "tgz", digest: { algorithm: "sha1", value: Buffer.from(shasum, "hex") } };
}

async function pypiArchive(fetcher: Fetcher, ref: PackageRef, version: string): Promise<Archive> {
	const doc = await getJson(
		fetcher,
		`https://pypi.org/pypi/${ref.name}/${encodeURIComponent(version)}/json`,
	);
	const files = (Array.isArray(doc.urls) ? doc.urls : []).map(record);
	if (!files.length) throw new Unavailable("noArchive");
	const named = (f: Record<string, unknown>, end: string) => text(f.filename).endsWith(end);
	const file =
		files.find((f) => f.packagetype === "sdist" && named(f, ".tar.gz")) ??
		files.find((f) => f.packagetype === "sdist" && named(f, ".zip")) ??
		files.find((f) => named(f, "-none-any.whl")) ??
		files.find((f) => named(f, ".whl"));
	if (!file) throw new Unavailable("unsupported");
	const url = archiveUrl(file.url, "PyPI");
	if (!url) throw new Unavailable("unsupported");
	const sha256 = text(record(file.digests).sha256);
	if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Unavailable("integrity");
	return {
		url,
		format: named(file, ".tar.gz") ? "tgz" : "zip",
		digest: { algorithm: "sha256", value: Buffer.from(sha256, "hex") },
	};
}

/** The bytes at `url`, at most `MAX_ARCHIVE_BYTES`, whatever the headers say. */
async function readBytes(fetcher: Fetcher, url: string): Promise<Buffer> {
	const response = await fetcher(url, {
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT_MS * 4),
	});
	if (response.status === 404 || response.status === 410) throw new Unavailable("missing");
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	if (Number(response.headers.get("content-length") ?? "0") > MAX_ARCHIVE_BYTES) {
		throw new Unavailable("tooLarge");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_ARCHIVE_BYTES) {
			await reader.cancel();
			throw new Unavailable("tooLarge");
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

function sources(archive: Archive, bytes: Buffer): SourceFiles {
	const digest = crypto.createHash(archive.digest.algorithm).update(bytes).digest();
	if (!digest.equals(archive.digest.value)) throw new Unavailable("integrity");
	try {
		return archive.format === "tgz" ? readTarGz(bytes) : readZip(bytes);
	} catch (error) {
		// The readers throw nothing but an ArchiveError.
		throw new Unavailable((error as ArchiveError).code);
	}
}

function versionOk(ref: PackageRef, version: string): boolean {
	return (ref.ecosystem === "npm" ? NPM_VERSION : PYPI_VERSION).test(version);
}

type Cache = Record<string, McpCodeScan>;

export class SourceScanStore {
	constructor(
		private readonly file: string,
		private readonly fetcher: Fetcher = fetch,
		private readonly now: () => number = Date.now,
	) {}

	private static key(ref: PackageRef, version: string): string {
		return `${ref.ecosystem}:${ref.name}@${version}`;
	}

	private read(): Cache {
		try {
			return record(JSON.parse(fs.readFileSync(this.file, "utf-8"))) as Cache;
		} catch {
			return {};
		}
	}

	private write(cache: Cache): void {
		const kept = Object.entries(cache)
			.sort(([, a], [, b]) => b.scannedAt.localeCompare(a.scannedAt))
			.slice(0, MAX_CACHED);
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(kept), null, 2), "utf-8");
	}

	/** The last scan of this version, without any network. */
	cached(ref: PackageRef, version: string | undefined): McpCodeScan | undefined {
		return version ? this.read()[SourceScanStore.key(ref, version)] : undefined;
	}

	/** The scan of `version`: kept, or read now; throws when the network fails. */
	async scan(ref: PackageRef, version: string): Promise<McpCodeScan> {
		const known = this.cached(ref, version);
		if (known) return known;
		if (!versionOk(ref, version)) throw new Error("version not scannable");
		const scannedAt = new Date(this.now()).toISOString();
		let result: McpCodeScan;
		try {
			const archive =
				ref.ecosystem === "npm"
					? await npmArchive(this.fetcher, ref, version)
					: await pypiArchive(this.fetcher, ref, version);
			const read = sources(archive, await readBytes(this.fetcher, archive.url));
			result = {
				status: "scanned",
				version,
				files: read.files.length,
				skipped: read.skipped,
				findings: scanSources(read.files),
				scannedAt,
			};
		} catch (error) {
			if (!(error instanceof Unavailable)) throw error;
			result = { status: "unavailable", version, reason: error.reason, scannedAt };
		}
		const cache = this.read();
		cache[SourceScanStore.key(ref, version)] = result;
		this.write(cache);
		return result;
	}
}

/**
 * The scan for a score: read (or kept) when `online`, else the kept one;
 * "unknown" when there is none or the network failed.
 */
export async function codeScanFor(
	store: SourceScanStore,
	ref: PackageRef,
	version: string | undefined,
	online: boolean,
): Promise<McpCodeScan | "unknown"> {
	if (!version) return "unknown";
	if (!online) return store.cached(ref, version) ?? "unknown";
	try {
		return await store.scan(ref, version);
	} catch {
		return "unknown";
	}
}
