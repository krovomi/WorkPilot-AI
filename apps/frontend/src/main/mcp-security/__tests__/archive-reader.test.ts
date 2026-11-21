import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	ArchiveError,
	MAX_SOURCE_BYTES,
	MAX_SOURCE_FILES,
	MAX_UNPACKED_BYTES,
	readTarGz,
	readZip,
} from "../archive-reader";
import { paxRecord, tar, tgz, zip } from "./archive-world";

function code(read: () => unknown): string | undefined {
	try {
		read();
	} catch (error) {
		return error instanceof ArchiveError ? error.code : "other";
	}
	return undefined;
}

describe("readTarGz", () => {
	it("reads the source files of an npm tarball, without the top folder", () => {
		const read = readTarGz(
			tgz([
				{ name: "package/", type: "5" },
				{ name: "package/package.json", body: "{}" },
				{ name: "package/dist/index.js", body: "fetch(u)" },
				{ name: "package/dist/index.d.ts", body: "x" },
				{ name: "package/test/a.js", body: "eval(x)" },
				{ name: "package/lib/old.js", body: "old", type: "" },
				{ name: "package/lib/big.js", body: "x", type: "7" },
				{ name: "top.js", body: "top" },
			]),
		);
		expect(read.files.map((f) => f.path)).toEqual(["dist/index.js", "lib/old.js", "lib/big.js", "top.js"]);
		expect(read.files[0].text).toBe("fetch(u)");
		expect(read.skipped).toBe(0);
	});

	it("follows ustar prefixes, pax and GNU long names", () => {
		const long = `pkg-1.0/${"d/".repeat(60)}server.py`;
		const read = readTarGz(
			tgz([
				{ name: "server.py", prefix: "pkg-1.0/src", body: "a" },
				{ name: "PaxHeader", type: "x", body: paxRecord(long) },
				{ name: "short-name", body: "b" },
				{ name: "PaxHeader", type: "x", body: "13 mtime=1.0\n" },
				{ name: "pkg-1.0/plain.py", body: "c" },
				{ name: "././@LongLink", type: "L", body: `pkg-1.0/${"e".repeat(120)}.py\0` },
				{ name: "truncated", body: "d" },
				{ name: `pkg-1.0/${"f".repeat(89)}.py`, body: "e" },
			]),
		);
		expect(read.files.map((f) => f.path)).toEqual([
			"src/server.py",
			long.slice("pkg-1.0/".length),
			"plain.py",
			`${"e".repeat(120)}.py`,
			`${"f".repeat(89)}.py`,
		]);
	});

	it("skips files over the size limit and after the file limit", () => {
		const big = readTarGz(tgz([{ name: "p/big.js", body: Buffer.alloc(MAX_SOURCE_BYTES + 1, 97) }]));
		expect(big).toEqual({ files: [], skipped: 1 });
		const many = Array.from({ length: MAX_SOURCE_FILES + 2 }, (_, i) => ({
			name: `p/f${i}.js`,
			body: "x",
		}));
		const read = readTarGz(tgz(many));
		expect(read.files).toHaveLength(MAX_SOURCE_FILES);
		expect(read.skipped).toBe(2);
	});

	it("reads an archive without end blocks, and an empty size field", () => {
		const read = readTarGz(tgz([{ name: "p/a.js", body: "", sizeField: "" }], { end: false }));
		expect(read.files).toEqual([{ path: "a.js", text: "" }]);
	});

	it("refuses what is not a tar.gz, a broken header or a truncated entry", () => {
		expect(code(() => readTarGz(Buffer.from("not gzip")))).toBe("unsupported");
		expect(code(() => readTarGz(tgz([{ name: "p/a.js", body: "x", sizeField: "zz" }])))).toBe(
			"unsupported",
		);
		const whole = tar([{ name: "p/a.js", body: "x".repeat(600) }], { end: false });
		expect(code(() => readTarGz(zlib.gzipSync(whole.subarray(0, 700))))).toBe("unsupported");
	});

	it("refuses an archive that inflates past the limit", () => {
		const bomb = zlib.gzipSync(Buffer.alloc(MAX_UNPACKED_BYTES + 1024));
		expect(code(() => readTarGz(bomb))).toBe("tooLarge");
	});
});

describe("readZip", () => {
	it("reads a wheel's source files, stored or deflated", () => {
		const read = readZip(
			zip([
				{ name: "pkg/server.py", body: "subprocess.run(x)" },
				{ name: "pkg/util.py", body: "y = 1", method: 0 },
				{ name: "pkg-1.0.dist-info/METADATA", body: "Name: pkg" },
			]),
		);
		expect(read.files).toEqual([
			{ path: "pkg/server.py", text: "subprocess.run(x)" },
			{ path: "pkg/util.py", text: "y = 1" },
		]);
	});

	it("skips a file its header says is too large", () => {
		expect(readZip(zip([{ name: "a.py", body: "x", sizeField: MAX_SOURCE_BYTES + 1 }]))).toEqual({
			files: [],
			skipped: 1,
		});
	});

	it("refuses an entry larger than its header says", () => {
		const big = Buffer.alloc(MAX_SOURCE_BYTES + 1, 97);
		expect(code(() => readZip(zip([{ name: "a.py", body: big, sizeField: 1 }])))).toBe("unsupported");
		expect(code(() => readZip(zip([{ name: "a.py", body: big, method: 0, sizeField: 1 }])))).toBe(
			"unsupported",
		);
	});

	it("refuses a zip that inflates past the limit in all", () => {
		const body = Buffer.alloc(MAX_SOURCE_BYTES, 97);
		const count = Math.ceil(MAX_UNPACKED_BYTES / MAX_SOURCE_BYTES) + 1;
		const entries = Array.from({ length: count }, (_, i) => ({ name: `f${i}.py`, body }));
		expect(code(() => readZip(zip(entries)))).toBe("tooLarge");
	});

	it("refuses what is not a zip it can read", () => {
		expect(code(() => readZip(Buffer.from("short")))).toBe("unsupported");
		expect(code(() => readZip(Buffer.alloc(100)))).toBe("unsupported");
		expect(code(() => readZip(zip([{ name: "a.py", body: "x", method: 12 }])))).toBe("unsupported");
		expect(code(() => readZip(zip([{ name: "a.py", body: "x", localOffset: 10 }])))).toBe(
			"unsupported",
		);
		expect(code(() => readZip(zip([{ name: "a.py", body: "x", localOffset: 1 << 30 }])))).toBe(
			"unsupported",
		);
		const broken = zip([{ name: "a.py", body: "x" }]);
		broken.writeUInt32LE(0, broken.length - 22 - 50);
		expect(code(() => readZip(broken))).toBe("unsupported");
		expect(code(() => readZip(null as unknown as Buffer))).toBe("unsupported");
	});

	it("refuses an entry whose data runs past the end", () => {
		const archive = zip([{ name: "a.py", body: "x", method: 0 }]);
		archive.writeUInt32LE(1 << 20, archive.length - 22 - 50 + 20);
		expect(code(() => readZip(archive))).toBe("unsupported");
	});
});
