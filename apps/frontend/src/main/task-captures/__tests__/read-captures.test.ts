/**
 * @vitest-environment node
 *
 * A task's captures read from real files, as the backend writes them
 * (`pr_captures/publication.py`, `core/capture_hosting/`): the summary keeps
 * only checked, bounded fields, the newest copy of the spec folder wins, an
 * approval covers the current copies only, and an image is served only when
 * the publication lists it as a PNG inside `captures/published/`.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	capturesSpecDir,
	hasCaptures,
	publishedFile,
	readCapturesSummary,
	readPublishedImage,
} from "../read-captures";

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("fake-png-body"),
]);

let root = "";

function side(file: string, signature: string, extra: Record<string, unknown> = {}) {
	return {
		source: `captures/task/${path.basename(file)}`,
		file,
		signature,
		protected: true,
		privacy: {
			status: "pseudonymized",
			replaced: 2,
			checks: ["page"],
			kinds: ["email", "phone"],
			notes: [],
		},
		publishable: true,
		...extra,
	};
}

function writeSpec(dir: string, publication: unknown, extra: Record<string, unknown> = {}) {
	mkdirSync(path.join(dir, "captures", "published", "task"), { recursive: true });
	mkdirSync(path.join(dir, "captures", "published", "base"), { recursive: true });
	writeFileSync(path.join(dir, "captures", "publication.json"), JSON.stringify(publication));
	for (const [name, content] of Object.entries(extra)) {
		writeFileSync(path.join(dir, "captures", name), JSON.stringify(content));
	}
}

function publication(items: unknown[], publish = "auto") {
	return {
		version: 1,
		generatedAt: "2026-11-28T16:00:00+00:00",
		decision: { needed: true, reason: "ui-files", decidedBy: "default", uiFiles: ["src/App.tsx"] },
		settings: { publish, protect: true, publishUnchecked: false },
		items,
		publishable: items.length,
		withheld: 0,
	};
}

const ITEM = {
	key: "web|orders|fr",
	label: "Orders",
	platform: "web",
	variant: "",
	route: "/orders",
	locale: "fr",
	source: "verify",
	before: side("captures/published/base/web--orders--fr.png", "1:1"),
	after: side("captures/published/task/web--orders--fr.png", "2:2"),
	publishable: true,
};

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-captures-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readCapturesSummary", () => {
	it("keeps the fields the app shows, kinds and counts but no value", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, publication([ITEM]), {
			"pr-sync.json": {
				version: 1,
				prUrl: "https://github.com/o/r/pull/7",
				status: "published",
				hosted: 2,
				section: true,
				reason: "",
				syncedAt: "2026-11-28T16:05:00+00:00",
			},
		});
		const summary = readCapturesSummary(spec);
		expect(summary).toMatchObject({
			needed: true,
			reason: "ui-files",
			publish: "auto",
			publishable: 1,
			withheld: 0,
			approved: false,
			sync: { status: "published", prUrl: "https://github.com/o/r/pull/7", section: true },
		});
		expect(summary?.items[0]).toMatchObject({
			label: "Orders",
			after: {
				available: true,
				status: "pseudonymized",
				kinds: ["email", "phone"],
				passes: ["page"],
				replaced: 2,
				file: "captures/published/task/web--orders--fr.png",
			},
		});
		expect(hasCaptures(summary)).toBe(true);
	});

	it("drops what does not have the backend's shape", () => {
		const spec = path.join(root, "spec");
		writeSpec(
			spec,
			publication([
				{
					...ITEM,
					label: "Line\nbreak\u0007",
					platform: "<script>",
					after: side("../../../etc/passwd", "3:3", {
						privacy: { status: "nonsense", kinds: ["ok", "<b>", 3] },
					}),
				},
				"not an item",
			]),
			{ "pr-sync.json": { status: "published", prUrl: "javascript:alert(1)" } },
		);
		const summary = readCapturesSummary(spec);
		expect(summary?.items).toHaveLength(1);
		const item = summary?.items[0];
		expect(item?.label).toBe("Linebreak");
		expect(item?.platform).toBe("web");
		expect(item?.after).toMatchObject({ available: false, file: "", status: "failed", kinds: ["ok"] });
		expect(item?.publishable).toBe(false);
		expect(summary?.sync?.prUrl).toBe("");
	});

	it("refuses another version and an unreadable file", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, { ...publication([ITEM]), version: 2 });
		expect(readCapturesSummary(spec)).toBeUndefined();
		writeFileSync(path.join(spec, "captures", "publication.json"), "{not json");
		expect(readCapturesSummary(spec)).toBeUndefined();
		expect(readCapturesSummary(path.join(root, "missing"))).toBeUndefined();
	});

	it("is approved only when every current copy was published by a person", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, publication([ITEM], "review"), {
			"approval.json": { signatures: ["2:2"] },
		});
		expect(readCapturesSummary(spec)?.approved).toBe(false);
		writeFileSync(
			path.join(spec, "captures", "approval.json"),
			JSON.stringify({ signatures: ["1:1", "2:2"] }),
		);
		expect(readCapturesSummary(spec)?.approved).toBe(true);
	});
});

describe("capturesSpecDir", () => {
	it("takes the copy whose publication is the newest", () => {
		const main = path.join(root, "main");
		const worktree = path.join(root, "worktree");
		writeSpec(main, publication([ITEM]));
		writeSpec(worktree, publication([ITEM]));
		const old = new Date("2026-01-01T00:00:00Z");
		utimesSync(path.join(main, "captures", "publication.json"), old, old);
		expect(capturesSpecDir([main, worktree, undefined])).toBe(worktree);
		expect(capturesSpecDir([path.join(root, "none")])).toBeUndefined();
	});
});

describe("readPublishedImage", () => {
	it("serves a listed PNG of captures/published/", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, publication([ITEM]));
		writeFileSync(path.join(spec, "captures/published/task/web--orders--fr.png"), PNG);
		const summary = readCapturesSummary(spec);
		if (!summary) throw new Error("no summary");
		const image = readPublishedImage(spec, summary, "captures/published/task/web--orders--fr.png");
		expect(image).toEqual({ base64: PNG.toString("base64") });
	});

	it("refuses a file the publication does not list, or that is not a PNG", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, publication([ITEM]));
		writeFileSync(path.join(spec, "captures/published/task/web--orders--fr.png"), "GIF89a");
		writeFileSync(path.join(spec, "captures/published/task/other.png"), PNG);
		const summary = readCapturesSummary(spec);
		if (!summary) throw new Error("no summary");
		expect(readPublishedImage(spec, summary, "captures/published/task/other.png")).toEqual({
			error: "not-listed",
		});
		expect(readPublishedImage(spec, summary, "captures/task/web--orders--fr.png")).toEqual({
			error: "not-listed",
		});
		expect(readPublishedImage(spec, summary, 42)).toEqual({ error: "not-listed" });
		expect(
			readPublishedImage(spec, summary, "captures/published/task/web--orders--fr.png"),
		).toEqual({ error: "not-png" });
	});

	it("refuses a listed name that resolves out of the folder (link)", () => {
		const spec = path.join(root, "spec");
		writeSpec(spec, publication([ITEM]));
		const outside = path.join(root, "secret.png");
		writeFileSync(outside, PNG);
		symlinkSync(outside, path.join(spec, "captures/published/task/web--orders--fr.png"));
		const summary = readCapturesSummary(spec);
		if (!summary) throw new Error("no summary");
		expect(
			readPublishedImage(spec, summary, "captures/published/task/web--orders--fr.png"),
		).toEqual({ error: "outside" });
	});
});

describe("publishedFile", () => {
	it("accepts only a relative PNG under captures/published/", () => {
		expect(publishedFile("captures/published/task/a.png")).toBe("captures/published/task/a.png");
		expect(publishedFile("captures\\published\\task\\a.png")).toBe("captures/published/task/a.png");
		expect(publishedFile("captures/published/../task/a.png")).toBe("");
		expect(publishedFile("/captures/published/task/a.png")).toBe("");
		expect(publishedFile("captures/published/task/a.svg")).toBe("");
		expect(publishedFile("captures/task/a.png")).toBe("");
	});
});
