import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fetcher, PackageRef } from "../registry-facts";
import { archiveUrl, codeScanFor, MAX_ARCHIVE_BYTES, SourceScanStore } from "../source-scan";
import { tgz, zip } from "./archive-world";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const NPM: PackageRef = { ecosystem: "npm", name: "@demo/mcp" };
const PYPI: PackageRef = { ecosystem: "PyPI", name: "demo-mcp" };
const TARBALL = "https://registry.npmjs.org/@demo/mcp/-/mcp-1.2.3.tgz";
const SDIST = "https://files.pythonhosted.org/packages/aa/demo_mcp-1.0.0.tar.gz";
const WHEEL = "https://files.pythonhosted.org/packages/bb/demo_mcp-1.0.0-py3-none-any.whl";

const ARCHIVE = tgz([
	{ name: "package/dist/index.js", body: 'const cp = require("child_process");\nfetch(u);' },
	{ name: "package/test/x.js", body: "eval(x)" },
]);

const sha512 = (b: Buffer) => `sha512-${crypto.createHash("sha512").update(b).digest("base64")}`;
const hex = (algorithm: string, b: Buffer) => crypto.createHash(algorithm).update(b).digest("hex");

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

type Answer = () => Response | Promise<Response>;

/** A fetcher that answers by URL, and records each call. */
function fetcher(answers: Record<string, Answer>) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fn: Fetcher = async (url, init) => {
		calls.push({ url, init });
		const answer = answers[url];
		if (!answer) throw new Error(`unexpected ${url}`);
		return answer();
	};
	return { fn, calls };
}

function npm(dist: Record<string, unknown>, archive: Answer = () => new Response(new Uint8Array(ARCHIVE))) {
	return {
		"https://registry.npmjs.org/@demo%2Fmcp/1.2.3": () => json({ dist }),
		[TARBALL]: archive,
	};
}

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scan-"));
	file = path.join(dir, "nested", "scans.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const store = (f: Fetcher) => new SourceScanStore(file, f, () => NOW);

describe("archiveUrl", () => {
	it("keeps only https on the registry's own file host", () => {
		expect(archiveUrl(TARBALL, "npm")).toBe(TARBALL);
		expect(archiveUrl(SDIST, "PyPI")).toBe(SDIST);
		expect(archiveUrl(SDIST, "npm")).toBeNull();
		expect(archiveUrl("http://registry.npmjs.org/x.tgz", "npm")).toBeNull();
		expect(archiveUrl("https://u:p@registry.npmjs.org/x.tgz", "npm")).toBeNull();
		expect(archiveUrl("https://registry.npmjs.org:444/x.tgz", "npm")).toBeNull();
		expect(archiveUrl("https://registry.npmjs.org.evil.test/x.tgz", "npm")).toBeNull();
		expect(archiveUrl("not a url", "npm")).toBeNull();
		expect(archiveUrl(3, "npm")).toBeNull();
		expect(archiveUrl(`https://registry.npmjs.org/${"a".repeat(1_000)}`, "npm")).toBeNull();
	});
});

describe("SourceScanStore", () => {
	it("scans the npm tarball checked against its sha512, then keeps the result", async () => {
		const { fn, calls } = fetcher(npm({ tarball: TARBALL, integrity: `sha1-x ${sha512(ARCHIVE)}` }));
		const scans = store(fn);
		const scan = await scans.scan(NPM, "1.2.3");
		expect(scan).toEqual({
			status: "scanned",
			version: "1.2.3",
			files: 1,
			skipped: 0,
			findings: [
				{ rule: "shellExec", file: "dist/index.js", line: 1, count: 1 },
				{ rule: "network", file: "dist/index.js", line: 2, count: 1 },
			],
			scannedAt: new Date(NOW).toISOString(),
		});
		expect(calls.map((c) => c.init?.redirect)).toEqual(["error", "error"]);
		expect(await scans.scan(NPM, "1.2.3")).toEqual(scan);
		expect(calls).toHaveLength(2);
		expect(scans.cached(NPM, "1.2.3")).toEqual(scan);
		expect(scans.cached(NPM, undefined)).toBeUndefined();
	});

	it("falls back on the sha1 shasum", async () => {
		const { fn } = fetcher(npm({ tarball: TARBALL, shasum: hex("sha1", ARCHIVE) }));
		expect((await store(fn).scan(NPM, "1.2.3")).status).toBe("scanned");
	});

	it("says the code cannot be audited, and why", async () => {
		const cases: [Record<string, Answer>, string][] = [
			[npm({}), "noArchive"],
			[npm({ tarball: "https://evil.test/x.tgz" }), "unsupported"],
			[npm({ tarball: TARBALL }), "integrity"],
			[npm({ tarball: TARBALL, shasum: hex("sha1", Buffer.from("other")) }), "integrity"],
			[{ "https://registry.npmjs.org/@demo%2Fmcp/1.2.3": () => json({}, 404) }, "missing"],
			[npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) }, () => new Response("", { status: 410 })), "missing"],
			[
				npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) }, () =>
					new Response("x", { headers: { "content-length": String(MAX_ARCHIVE_BYTES + 1) } }),
				),
				"tooLarge",
			],
			[npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) }, () => new Response(null)), "integrity"],
			[
				npm({ tarball: TARBALL, integrity: sha512(Buffer.from("not gzip")) }, () =>
					new Response("not gzip"),
				),
				"unsupported",
			],
		];
		for (const [answers, reason] of cases) {
			fs.rmSync(file, { force: true });
			const scan = await store(fetcher(answers).fn).scan(NPM, "1.2.3");
			expect(scan).toMatchObject({ status: "unavailable", version: "1.2.3", reason });
		}
	});

	it("stops reading an archive that grows past the limit, whatever its headers say", async () => {
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += chunk.length;
				controller.enqueue(chunk);
			},
		});
		const { fn } = fetcher(npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) }, () => new Response(body)));
		expect(await store(fn).scan(NPM, "1.2.3")).toMatchObject({ reason: "tooLarge" });
		expect(sent).toBeLessThan(MAX_ARCHIVE_BYTES + 3 * chunk.length);
	});

	it("throws, keeping nothing, when the registry fails or the version is not one", async () => {
		const failing = fetcher({ "https://registry.npmjs.org/@demo%2Fmcp/1.2.3": () => json({}, 500) });
		await expect(store(failing.fn).scan(NPM, "1.2.3")).rejects.toThrow("HTTP 500");
		const tarball = fetcher(npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) }, () => new Response("", { status: 503 })));
		await expect(store(tarball.fn).scan(NPM, "1.2.3")).rejects.toThrow("HTTP 503");
		const gone = fetcher({ "https://registry.npmjs.org/@demo%2Fmcp/1.2.3": () => json({}, 410) });
		expect(await store(gone.fn).scan(NPM, "1.2.3")).toMatchObject({ reason: "missing" });
		fs.rmSync(file, { force: true });
		const down = fetcher({
			"https://registry.npmjs.org/@demo%2Fmcp/1.2.3": () => {
				throw "socket closed";
			},
		});
		await expect(store(down.fn).scan(NPM, "1.2.3")).rejects.toBe("socket closed");
		const none = fetcher({});
		await expect(store(none.fn).scan(NPM, "latest")).rejects.toThrow("version");
		await expect(store(none.fn).scan(PYPI, "1.0/../x")).rejects.toThrow("version");
		expect(none.calls).toEqual([]);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("reads the PyPI sdist, else a wheel, checked against its sha256", async () => {
		const wheel = zip([{ name: "demo_mcp/server.py", body: "exec(code)" }]);
		const files = (list: Record<string, unknown>[]) => ({
			"https://pypi.org/pypi/demo-mcp/1.0.0/json": () => json({ urls: list }),
			[SDIST]: () => new Response(new Uint8Array(ARCHIVE)),
			[WHEEL]: () => new Response(new Uint8Array(wheel)),
		});
		const sdist = { packagetype: "sdist", filename: "demo_mcp-1.0.0.tar.gz", url: SDIST, digests: { sha256: hex("sha256", ARCHIVE) } };
		const whl = { packagetype: "bdist_wheel", filename: "demo_mcp-1.0.0-py3-none-any.whl", url: WHEEL, digests: { sha256: hex("sha256", wheel) } };

		const fromSdist = await store(fetcher(files([whl, sdist])).fn).scan(PYPI, "1.0.0");
		expect(fromSdist).toMatchObject({ status: "scanned", files: 1 });
		fs.rmSync(file);
		const fromWheel = await store(fetcher(files([whl])).fn).scan(PYPI, "1.0.0");
		expect(fromWheel).toMatchObject({ status: "scanned", findings: [{ rule: "dynamicCode" }] });

		const zipSdist = { ...sdist, filename: "demo_mcp-1.0.0.zip", url: WHEEL, digests: { sha256: hex("sha256", wheel) } };
		const otherWheel = { ...whl, filename: "demo_mcp-1.0.0-cp312-linux_x86_64.whl" };
		const cases: [Record<string, unknown>[], string][] = [
			[[zipSdist], "scanned"],
			[[otherWheel], "scanned"],
			[[], "noArchive"],
			[[{ packagetype: "bdist_egg", filename: "x.egg", url: WHEEL }], "unsupported"],
			[[{ ...sdist, url: "https://evil.test/x.tar.gz" }], "unsupported"],
			[[{ ...sdist, digests: {} }], "integrity"],
		];
		for (const [list, expected] of cases) {
			fs.rmSync(file, { force: true });
			const scan = await store(fetcher(files(list)).fn).scan(PYPI, "1.0.0");
			expect(scan.status === "scanned" ? "scanned" : scan.reason).toBe(expected);
		}
		fs.rmSync(file, { force: true });
		const noUrls = fetcher({ "https://pypi.org/pypi/demo-mcp/1.0.0/json": () => json({}) });
		expect(await store(noUrls.fn).scan(PYPI, "1.0.0")).toMatchObject({ reason: "noArchive" });
	});

	it("keeps the most recent scans only, and survives a broken cache file", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{broken");
		const answers = npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) });
		expect((await store(fetcher(answers).fn).scan(NPM, "1.2.3")).status).toBe("scanned");

		const old = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [
				`npm:old@1.0.${i}`,
				{ status: "unavailable", version: `1.0.${i}`, reason: "missing", scannedAt: "2026-01-01T00:00:00.000Z" },
			]),
		);
		fs.writeFileSync(file, JSON.stringify(old));
		await store(fetcher(answers).fn).scan(NPM, "1.2.3");
		const kept = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(Object.keys(kept)).toHaveLength(100);
		expect(kept["npm:@demo/mcp@1.2.3"]).toMatchObject({ status: "scanned" });
	});
});

describe("codeScanFor", () => {
	it("is unknown without a version, offline without a kept scan, or when the network fails", async () => {
		const scans = store(fetcher({}).fn);
		expect(await codeScanFor(scans, NPM, undefined, true)).toBe("unknown");
		expect(await codeScanFor(scans, NPM, "1.2.3", false)).toBe("unknown");
		expect(await codeScanFor(scans, NPM, "1.2.3", true)).toBe("unknown");
	});

	it("reads online, and gives the kept scan offline", async () => {
		const scans = store(fetcher(npm({ tarball: TARBALL, integrity: sha512(ARCHIVE) })).fn);
		const scan = await codeScanFor(scans, NPM, "1.2.3", true);
		expect(scan).toMatchObject({ status: "scanned" });
		expect(await codeScanFor(store(fetcher({}).fn), NPM, "1.2.3", false)).toEqual(scan);
	});
});
