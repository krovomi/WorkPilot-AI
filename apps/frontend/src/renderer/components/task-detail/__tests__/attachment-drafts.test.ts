import { describe, expect, it } from "vitest";
import type { DocintelDraftsPayload } from "../../../lib/agent-tools-api";
import {
	activeTables,
	mergeCriteria,
	offersExtraction,
	pendingRequirements,
	sourceLabel,
} from "../attachment-drafts";

function payload(overrides: Partial<DocintelDraftsPayload> = {}): DocintelDraftsPayload {
	return {
		drafts: null,
		pending: 0,
		readable: [],
		pdfBackends: ["pypdfium2"],
		vision: { images: [], available: false, reason: "no-image" },
		...overrides,
	};
}

describe("attachment drafts rules", () => {
	it("offers to read a specification, never a mere screenshot", () => {
		expect(offersExtraction(payload({ readable: ["attachments/cdc.pdf"] }))).toBe(true);
		expect(offersExtraction(payload({ readable: ["attachments/notes.md"] }))).toBe(true);
		expect(offersExtraction(payload({ readable: ["attachments/mockup.png"] }))).toBe(
			false,
		);
		expect(offersExtraction(null)).toBe(false);
	});

	it("does not offer again once the attachments were read", () => {
		const read = payload({
			readable: ["attachments/cdc.pdf"],
			drafts: { requirements: [], criteria: [], tables: [], sources: [], generated_at: "" },
		});
		expect(offersExtraction(read)).toBe(false);
	});

	it("lists only what still waits for a decision", () => {
		const drafts = payload({
			drafts: {
				requirements: [
					{ key: "a", id: "FR-002", kind: "FR", text: "x", source: "s", page: 0, ref: "", status: "proposed" },
					{ key: "b", id: "FR-003", kind: "FR", text: "y", source: "s", page: 0, ref: "", status: "rejected" },
				],
				criteria: [],
				tables: [
					{ key: "t1", table: { headers: [], rows: [], caption: "", source: "", page: 0 }, source: "s", tests: [], status: "rejected" },
					{ key: "t2", table: { headers: [], rows: [], caption: "", source: "", page: 0 }, source: "s", tests: [], status: "proposed" },
				],
				sources: [],
				generated_at: "",
			},
		});
		expect(pendingRequirements(drafts).map((r) => r.key)).toEqual(["a"]);
		expect(activeTables(drafts).map((t) => t.key)).toEqual(["t2"]);
	});

	it("merges accepted criteria once, keeping the existing order", () => {
		expect(
			mergeCriteria(["Totals match", "Export works"], ["totals  match", "Sorted by date "]),
		).toEqual(["Totals match", "Export works", "Sorted by date"]);
	});

	it("names the source with its page and the document's own reference", () => {
		expect(
			sourceLabel(
				{ source: "attachments/cdc.pdf", page: 3, ref: "EF-01" },
				(page) => `p. ${page}`,
			),
		).toBe("cdc.pdf, p. 3, EF-01");
		expect(sourceLabel({ source: "notes.md", page: 0 }, () => "never")).toBe("notes.md");
	});
});
