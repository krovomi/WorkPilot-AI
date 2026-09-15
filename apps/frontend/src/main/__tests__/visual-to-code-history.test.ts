/**
 * The construction history on disk.
 *
 * What is pinned here is the promise the feature makes: a step that was
 * recorded can be read back, and nothing silently throws away work. The cap,
 * the pin, the atomic write and the id check are the four places where that
 * promise could quietly stop holding.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA = "";

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => USER_DATA) },
}));

vi.mock("../app-logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
	appendVersion,
	deleteHistory,
	deleteVersion,
	getVersion,
	labelVersion,
	listVersions,
} from "../visual-to-code-history";
import { ARCHITECTURE_HISTORY_LIMIT } from "../../shared/types/visual-to-code-history";

const ARCH = "arch-1";

function step(label: string) {
	return {
		diagramType: "architecture",
		nodes: [{ id: "1", data: { label } }],
		edges: [],
	};
}

beforeEach(() => {
	USER_DATA = mkdtempSync(path.join(tmpdir(), "v2c-history-"));
});

afterEach(() => {
	rmSync(USER_DATA, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("visual-to-code history", () => {
	it("gives back the diagram a step captured", () => {
		appendVersion(ARCH, step("FrontEnd"));
		const [meta] = listVersions(ARCH);

		const version = getVersion(ARCH, meta.id);
		expect(version?.nodes).toEqual([{ id: "1", data: { label: "FrontEnd" } }]);
		expect(version?.diagramType).toBe("architecture");
	});

	it("lists steps oldest first, with their counts and without their bodies", () => {
		appendVersion(ARCH, step("one"));
		appendVersion(ARCH, {
			diagramType: "architecture",
			nodes: [{ id: "1" }, { id: "2" }],
			edges: [{ id: "e" }],
		});

		const versions = listVersions(ARCH);
		expect(versions).toHaveLength(2);
		expect(versions[1].nodeCount).toBe(2);
		expect(versions[1].edgeCount).toBe(1);
		// The panel draws sixty rows; it must not receive sixty diagrams to do it.
		expect(versions[0]).not.toHaveProperty("nodes");
		expect(versions[0]).not.toHaveProperty("edges");
	});

	it("keeps one history per architecture", () => {
		appendVersion(ARCH, step("a"));
		appendVersion("arch-2", step("b"));

		expect(listVersions(ARCH)).toHaveLength(1);
		expect(listVersions("arch-2")).toHaveLength(1);
	});

	it("drops the oldest anonymous steps once the cap is reached", () => {
		for (let i = 0; i < ARCHITECTURE_HISTORY_LIMIT + 5; i++) {
			appendVersion(ARCH, step(`step-${i}`));
		}

		const versions = listVersions(ARCH);
		expect(versions).toHaveLength(ARCHITECTURE_HISTORY_LIMIT);
		// The ones kept are the recent ones, in order.
		expect(versions[versions.length - 1].summary).toBeNull();
	});

	it("never drops a step somebody named", () => {
		appendVersion(ARCH, step("keep me"));
		const [first] = listVersions(ARCH);
		labelVersion(ARCH, first.id, "Avant la migration");

		for (let i = 0; i < ARCHITECTURE_HISTORY_LIMIT + 10; i++) {
			appendVersion(ARCH, step(`noise-${i}`));
		}

		const versions = listVersions(ARCH);
		const kept = versions.find((v) => v.id === first.id);
		expect(kept?.label).toBe("Avant la migration");
		expect(kept?.pinned).toBe(true);
		// The cap counts the anonymous ones only, so the named one is on top.
		expect(versions).toHaveLength(ARCHITECTURE_HISTORY_LIMIT + 1);
	});

	it("naming is what pins, and un-naming lets the cap have it back", () => {
		appendVersion(ARCH, step("a"));
		const [version] = listVersions(ARCH);

		expect(labelVersion(ARCH, version.id, "  Étape clé  ")[0]).toMatchObject({
			label: "Étape clé",
			pinned: true,
		});
		expect(labelVersion(ARCH, version.id, "   ")[0]).toMatchObject({
			label: null,
			pinned: false,
		});
	});

	it("deletes one step without touching the others", () => {
		appendVersion(ARCH, step("a"));
		appendVersion(ARCH, step("b"));
		const [first, second] = listVersions(ARCH);

		const left = deleteVersion(ARCH, first.id);
		expect(left.map((v) => v.id)).toEqual([second.id]);
	});

	it("deletes a whole history when its architecture goes", () => {
		appendVersion(ARCH, step("a"));
		deleteHistory(ARCH);

		expect(listVersions(ARCH)).toEqual([]);
		expect(existsSync(path.join(USER_DATA, "visual-to-code", "history", `${ARCH}.json`))).toBe(false);
	});

	it("reads an unknown architecture as an empty history rather than throwing", () => {
		expect(listVersions("never-seen")).toEqual([]);
		expect(getVersion("never-seen", "nope")).toBeNull();
	});

	it("survives a corrupted file instead of taking the canvas down", () => {
		appendVersion(ARCH, step("a"));
		const file = path.join(USER_DATA, "visual-to-code", "history", `${ARCH}.json`);
		writeFileSync(file, "{ this is not json", "utf-8");

		// The live document is not in this file; an empty timeline is a loss
		// worth reporting, a crash on opening the page is worse.
		expect(listVersions(ARCH)).toEqual([]);
		expect(() => appendVersion(ARCH, step("b"))).not.toThrow();
		expect(listVersions(ARCH)).toHaveLength(1);
	});

	it("refuses an id that would write outside its own directory", () => {
		for (const id of ["../escape", "a/b", "", "x".repeat(65)]) {
			expect(() => listVersions(id)).toThrow();
		}
	});

	it("leaves no half-written file behind", () => {
		appendVersion(ARCH, step("a"));
		const dir = path.join(USER_DATA, "visual-to-code", "history");
		const file = path.join(dir, `${ARCH}.json`);

		// The write goes through a temporary and a rename, so a reader never
		// sees a partial document and no `.tmp` is left lying around.
		expect(existsSync(`${file}.tmp`)).toBe(false);
		expect(() => JSON.parse(readFileSync(file, "utf-8"))).not.toThrow();
	});

	it("records what a step was restored from", () => {
		appendVersion(ARCH, step("a"));
		const [origin] = listVersions(ARCH);
		appendVersion(ARCH, { ...step("a"), restoredFrom: origin.id });

		expect(listVersions(ARCH)[1].restoredFrom).toBe(origin.id);
	});
});
