/**
 * The desktop app reads the review feedback dataset (#361) as the backend
 * does: same signatures (checked on cases both sides share), same latest
 * vote per finding, same resets, same bound.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_THRESHOLD,
	displayLabel,
	MAX_READ_BYTES,
	MAX_THRESHOLD,
	MIN_THRESHOLD,
	net,
	normalizeTitle,
	parseDataset,
	readTail,
	rejections,
	resetSignature,
	resolveThreshold,
	signature,
	tallyBySignature,
	topReason,
	validRecord,
} from "../review-feedback-dataset";

const SHARED = path.resolve(
	__dirname,
	"../../../../../../../tests/fixtures/review_feedback/signatures.json",
);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 1,
		pr: 1,
		finding_id: "f1",
		verdict: "rejected",
		reason: "too_pedantic",
		category: "style",
		severity: "low",
		title: "Missing docstring on `foo`",
		...overrides,
	};
}

function lines(...items: unknown[]): string {
	return items.map((item) => JSON.stringify(item)).join("\n");
}

describe("signature", () => {
	it("matches the backend on the shared cases", () => {
		const { cases } = JSON.parse(readFileSync(SHARED, "utf-8")) as {
			cases: Array<{
				category: string;
				title: string;
				normalized: string;
				signature: string;
			}>;
		};
		expect(cases.length).toBeGreaterThan(0);
		for (const item of cases) {
			expect(normalizeTitle(item.title)).toBe(item.normalized);
			expect(signature(item.category, item.title)).toBe(item.signature);
		}
	});

	it("does not split a remark on names and numbers", () => {
		expect(signature("style", "Missing docstring on `foo` (line 12)")).toBe(
			signature("style", "missing docstring on `bar` (line 7)"),
		);
	});
});

describe("resolveThreshold", () => {
	it("takes a whole number, bounded, else the default", () => {
		expect(resolveThreshold(undefined)).toBe(DEFAULT_THRESHOLD);
		expect(resolveThreshold("5x")).toBe(DEFAULT_THRESHOLD);
		expect(resolveThreshold(" 5 ")).toBe(5);
		expect(resolveThreshold("0")).toBe(MIN_THRESHOLD);
		expect(resolveThreshold("999")).toBe(MAX_THRESHOLD);
	});
});

describe("validRecord", () => {
	it("keeps a record the store writes, with its signature", () => {
		const valid = validRecord(record({ reason: undefined }));
		expect(valid).toMatchObject({ pr: 1, findingId: "f1", reason: null });
		expect(valid?.signature).toBe(signature("style", "Missing docstring on `foo`"));
	});

	it.each([
		["not an object", "x"],
		["an array", []],
		["another version", record({ v: 2 })],
		["a pr that is not a number", record({ pr: "1" })],
		["a fractional pr", record({ pr: 1.5 })],
		["a pr of zero", record({ pr: 0 })],
		["a pr too large", record({ pr: 1_000_000_000 })],
		["an id that is not one", record({ finding_id: "a b" })],
		["a missing id", record({ finding_id: 3 })],
		["an unknown verdict", record({ verdict: "maybe" })],
		["an unknown reason", record({ reason: "because" })],
		["a malformed category", record({ category: "Style!" })],
		["a missing category", record({ category: 1 })],
		["an unknown severity", record({ severity: "huge" })],
		["a missing severity", record({ severity: 2 })],
		["an empty title", record({ title: "  " })],
		["a missing title", record({ title: null })],
	])("refuses %s", (_name, value) => {
		expect(validRecord(value)).toBeNull();
	});
});

describe("resetSignature", () => {
	const sig = signature("style", "x");
	it("reads a reset line", () => {
		expect(resetSignature({ v: 1, kind: "reset", signature: sig })).toBe(sig);
	});
	it.each([
		[null],
		[{ v: 2, kind: "reset", signature: sig }],
		[{ v: 1, kind: "other", signature: sig }],
		[{ v: 1, kind: "reset", signature: sig.toUpperCase() }],
		[{ v: 1, kind: "reset", signature: 7 }],
	])("ignores %j", (value) => {
		expect(resetSignature(value)).toBeNull();
	});
});

describe("parseDataset", () => {
	it("keeps the latest vote per finding and skips junk", () => {
		const text = [
			lines(record(), record({ verdict: "accepted" })),
			"",
			"not json",
			lines(record({ v: 9 }), record({ pr: 2 })),
		].join("\n");
		const records = parseDataset(text);
		expect(records.map((r) => [r.pr, r.verdict])).toEqual([
			[1, "accepted"],
			[2, "rejected"],
		]);
	});

	it("forgets what came before a reset on its signature only", () => {
		const sig = signature("style", "Missing docstring on `foo`");
		const text = lines(
			record({ pr: 1 }),
			record({ pr: 2, title: "Prefer an early return" }),
			{ v: 1, kind: "reset", signature: sig },
			record({ pr: 3 }),
		);
		expect(parseDataset(text).map((r) => r.pr)).toEqual([2, 3]);
	});
});

describe("tallies", () => {
	it("counts each verdict, the reasons and the newest wording", () => {
		const records = parseDataset(
			lines(
				record({ pr: 1, reason: "other" }),
				record({ pr: 2, verdict: "not_applicable", reason: null }),
				record({ pr: 3, verdict: "accepted", title: "Missing docstring on `x`" }),
				record({ pr: 4, reason: "false_positive" }),
			),
		);
		const [tally] = [...tallyBySignature(records).values()];
		expect(tally).toMatchObject({
			accepted: 1,
			rejected: 2,
			notApplicable: 1,
			title: "Missing docstring on `foo`",
		});
		expect(rejections(tally)).toBe(3);
		expect(net(tally)).toBe(2);
		// A tie goes to the first reason in alphabetical order.
		expect(topReason(tally)).toBe("false_positive");
	});

	it("names no reason when none was given", () => {
		const [tally] = [
			...tallyBySignature(parseDataset(lines(record({ reason: null })))).values(),
		];
		expect(topReason(tally)).toBeNull();
	});

	it("prefers the reason given most", () => {
		const [tally] = [
			...tallyBySignature(
				parseDataset(
					lines(
						record({ pr: 1, reason: "too_pedantic" }),
						record({ pr: 2, reason: "too_pedantic" }),
						record({ pr: 3, reason: "false_positive" }),
					),
				),
			).values(),
		];
		expect(topReason(tally)).toBe("too_pedantic");
	});
});

describe("displayLabel", () => {
	it("is one bounded line without control characters", () => {
		expect(displayLabel("a\u0000b\nc\u007f  d")).toBe("a b c d");
		expect(Array.from(displayLabel("é".repeat(500)))).toHaveLength(120);
	});
});

describe("readTail", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "review-dataset-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a small file whole", () => {
		const file = path.join(dir, "small.jsonl");
		writeFileSync(file, "one\ntwo\n");
		expect(readTail(file)).toBe("one\ntwo\n");
	});

	it("reads only the newest part of a large one, from a whole line", () => {
		const file = path.join(dir, "large.jsonl");
		const line = `${"x".repeat(99)}\n`;
		writeFileSync(file, `${line.repeat(MAX_READ_BYTES / line.length + 10)}last\n`);
		const text = readTail(file);
		expect(text.length).toBeLessThanOrEqual(MAX_READ_BYTES);
		expect(text.startsWith("x")).toBe(true);
		expect(text.endsWith("last\n")).toBe(true);
	});

	it("is empty when the newest part holds no whole line", () => {
		const file = path.join(dir, "one-line.jsonl");
		writeFileSync(file, "y".repeat(MAX_READ_BYTES + 5));
		expect(readTail(file)).toBe("");
	});
});
