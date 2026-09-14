/**
 * @vitest-environment jsdom
 */

/**
 * The run belongs to the window, not to the page.
 *
 * These pin the two properties the Visual-to-Code page rests on: a generation
 * keeps being heard while nobody is on the page (the listeners are the
 * session's, registered once by the bootstrap), and its result is waiting when
 * the page comes back. They used to live in `CanvasPanel`, in a `useEffect`
 * whose cleanup ran on unmount — so navigating away meant the files, the
 * completion and the failure all fell on the floor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler<T> = (payload: T) => void;

const handlers: {
	status?: Handler<string>;
	file?: Handler<{ filename: string; language: string; content: string }>;
	writing?: Handler<string>;
	error?: Handler<string>;
	complete?: Handler<{ action: string; data: unknown }>;
} = {};

const historyApi = {
	list: vi.fn(async () => ({ success: true, data: [] })),
	get: vi.fn(async () => ({ success: true, data: null })),
	append: vi.fn(async () => ({ success: true, data: [] })),
	label: vi.fn(async () => ({ success: true, data: [] })),
	deleteVersion: vi.fn(async () => ({ success: true, data: [] })),
	deleteAll: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
	vi.resetModules();
	for (const fn of Object.values(historyApi)) fn.mockClear();
	for (const key of Object.keys(handlers)) {
		delete handlers[key as keyof typeof handlers];
	}
	localStorage.clear();

	Object.defineProperty(globalThis, "electronAPI", {
		value: {
			onVisualProgrammingStatus: (cb: Handler<string>) => {
				handlers.status = cb;
				return vi.fn();
			},
			onVisualProgrammingFile: (
				cb: Handler<{ filename: string; language: string; content: string }>,
			) => {
				handlers.file = cb;
				return vi.fn();
			},
			onVisualProgrammingWriting: (cb: Handler<string>) => {
				handlers.writing = cb;
				return vi.fn();
			},
			onVisualProgrammingError: (cb: Handler<string>) => {
				handlers.error = cb;
				return vi.fn();
			},
			onVisualProgrammingComplete: (
				cb: Handler<{ action: string; data: unknown }>,
			) => {
				handlers.complete = cb;
				return vi.fn();
			},
			listArchitectureVersions: historyApi.list,
			getArchitectureVersion: historyApi.get,
			appendArchitectureVersion: historyApi.append,
			labelArchitectureVersion: historyApi.label,
			deleteArchitectureVersion: historyApi.deleteVersion,
			deleteArchitectureHistory: historyApi.deleteAll,
		},
		writable: true,
		configurable: true,
	});
});

async function load() {
	const module = await import("../visual-to-code-store");
	module.setupVisualToCodeListeners();
	return module.useVisualToCodeStore;
}

const FILE = {
	filename: "src/App.tsx",
	language: "typescript",
	content: "export {};",
};

describe("visual-to-code run state", () => {
	it("starts a code run in `generating`, with the dock open and nothing stale in it", async () => {
		const store = await load();
		store.setState({ streamedFiles: [FILE], error: "previous failure" });

		store.getState().startRun("generate-code");

		expect(store.getState().phase).toBe("generating");
		expect(store.getState().dockOpen).toBe(true);
		expect(store.getState().streamedFiles).toEqual([]);
		expect(store.getState().error).toBeNull();
	});

	it("does not open the dock for a reverse run, whose answer is the canvas", async () => {
		const store = await load();

		store.getState().startRun("code-to-visual");

		expect(store.getState().dockOpen).toBe(false);
	});

	it("collects files as they stream in, with no page mounted", async () => {
		const store = await load();
		store.getState().startRun("generate-code");

		handlers.writing?.("src/App.tsx");
		expect(store.getState().writingFile).toBe("src/App.tsx");

		handlers.file?.(FILE);
		expect(store.getState().streamedFiles).toEqual([FILE]);
		// A file that arrived is no longer the file being written.
		expect(store.getState().writingFile).toBeNull();
	});

	it("keeps one entry per filename when the model writes the same file twice", async () => {
		const store = await load();
		store.getState().startRun("generate-code");

		handlers.file?.(FILE);
		handlers.file?.({ ...FILE, content: "export const a = 1;" });

		expect(store.getState().streamedFiles).toHaveLength(1);
		expect(store.getState().streamedFiles[0].content).toBe(
			"export const a = 1;",
		);
	});

	it("lets the parsed answer replace what was scraped mid-stream", async () => {
		const store = await load();
		store.getState().startRun("generate-code");
		handlers.file?.(FILE);

		const result = {
			files: [FILE, { filename: "b.ts", language: "ts", content: "b" }],
			summary: "Two files",
			instructions: "",
		};
		handlers.complete?.({ action: "generate-code", data: result });

		expect(store.getState().phase).toBe("complete");
		expect(store.getState().streamedFiles).toHaveLength(2);
		expect(store.getState().codeResult).toEqual(result);
	});

	it("shows a truncated run as the files it did finish", async () => {
		const store = await load();
		store.getState().startRun("generate-code");
		handlers.file?.(FILE);

		// What the service sends when the run was killed mid-answer: the files
		// whose own JSON closed, and a flag saying that is not the whole thing.
		handlers.complete?.({
			action: "generate-code",
			data: { files: [FILE], summary: "", instructions: "", truncated: true },
		});

		expect(store.getState().phase).toBe("complete");
		expect(store.getState().streamedFiles).toEqual([FILE]);
		expect(store.getState().codeResult?.truncated).toBe(true);
	});

	it("survives a completion that carries no files at all", async () => {
		const store = await load();
		store.getState().startRun("generate-code");

		handlers.complete?.({
			action: "generate-code",
			data: { summary: "nothing to do" },
		});

		expect(store.getState().phase).toBe("complete");
		expect(store.getState().streamedFiles).toEqual([]);
	});

	it("parks a reverse result until the canvas takes it", async () => {
		const store = await load();
		store.getState().startRun("code-to-visual");

		const diagram = { nodes: [], edges: [], summary: "one file" };
		handlers.complete?.({ action: "code-to-visual", data: diagram });

		// The canvas may be unmounted right now; the answer waits for it.
		expect(store.getState().pendingDiagram).toEqual(diagram);

		expect(store.getState().consumePendingDiagram()).toEqual(diagram);
		// And is taken exactly once, so a remount does not re-import it.
		expect(store.getState().pendingDiagram).toBeNull();
		expect(store.getState().consumePendingDiagram()).toBeNull();
	});

	it("reports a failure as a phase the sidebar can read, not only as a toast", async () => {
		const store = await load();
		store.getState().startRun("generate-code");

		handlers.error?.("the provider returned nothing");

		expect(store.getState().phase).toBe("error");
		expect(store.getState().error).toBe("the provider returned nothing");
		// The failure is worth showing even if the dock had been closed.
		expect(store.getState().dockOpen).toBe(true);
	});

	it("registers nothing, and does not throw, without the preload bridge", async () => {
		Object.defineProperty(globalThis, "electronAPI", {
			value: undefined,
			writable: true,
			configurable: true,
		});

		const module = await import("../visual-to-code-store");
		expect(() => module.setupVisualToCodeListeners()()).not.toThrow();
	});
});


// ── The documents ─────────────────────────────────────────────────────

describe("architectures", () => {
	it("opens on one document, so the canvas always has something to render", async () => {
		const store = await load();

		expect(store.getState().architectures).toHaveLength(1);
		expect(store.getState().activeArchitectureId).toBe(
			store.getState().architectures[0].id,
		);
	});

	it("keeps a diagram saved before the feature existed, under a name", async () => {
		// What version 1 wrote: one diagram, in three loose fields.
		localStorage.setItem(
			"visual-to-code-canvas",
			JSON.stringify({
				version: 1,
				state: {
					canvasNodes: [{ id: "1", data: { label: "BackEnd DotNet" } }],
					canvasEdges: [{ id: "e", source: "1", target: "1" }],
					canvasDiagramType: "flowchart",
				},
			}),
		);

		const store = await load();
		const [architecture] = store.getState().architectures;

		// Whoever had a diagram open when they updated must find it where they
		// left it — discovering the feature by losing your work is not a
		// migration.
		expect(store.getState().architectures).toHaveLength(1);
		expect(architecture.nodes).toEqual([
			{ id: "1", data: { label: "BackEnd DotNet" } },
		]);
		expect(architecture.edges).toHaveLength(1);
		expect(architecture.diagramType).toBe("flowchart");
		expect(architecture.name).toBeTruthy();
	});

	it("survives a version-1 payload that carried nothing at all", async () => {
		localStorage.setItem(
			"visual-to-code-canvas",
			JSON.stringify({ version: 1, state: {} }),
		);

		const store = await load();
		expect(store.getState().architectures).toHaveLength(1);
		expect(store.getState().architectures[0].nodes).toEqual([]);
	});

	it("creates independent documents, and makes the new one active", async () => {
		const store = await load();
		const first = store.getState().activeArchitectureId;

		const second = store.getState().createArchitecture("Mobile");

		expect(store.getState().architectures).toHaveLength(2);
		expect(store.getState().activeArchitectureId).toBe(second);
		expect(second).not.toBe(first);
		// A fresh document must not show the previous one's timeline.
		expect(store.getState().versions).toEqual([]);
	});

	it("copies a document without sharing its history", async () => {
		const store = await load();
		const source = store.getState().architectures[0];
		store.getState().updateArchitecture(source.id, {
			nodes: [{ id: "1" }] as never,
			edges: [],
		});

		const copyId = store.getState().duplicateArchitecture(source.id);
		const copy = store.getState().architectures.find((a) => a.id === copyId);

		expect(copy?.nodes).toHaveLength(1);
		// Two documents writing into one history file is one document with two
		// authors; the copy gets its own id and therefore its own timeline.
		expect(copyId).not.toBe(source.id);
	});

	it("renames, and refuses a name that is only spaces", async () => {
		const store = await load();
		const { id } = store.getState().architectures[0];

		store.getState().renameArchitecture(id, "  Paiement  ");
		expect(store.getState().architectures[0].name).toBe("Paiement");

		store.getState().renameArchitecture(id, "   ");
		expect(store.getState().architectures[0].name).toBe("Paiement");
	});

	it("deletes the document and its history together", async () => {
		const store = await load();
		const second = store.getState().createArchitecture("Mobile");

		store.getState().deleteArchitecture(second);

		expect(store.getState().architectures).toHaveLength(1);
		expect(historyApi.deleteAll).toHaveBeenCalledWith(second);
	});

	it("leaves an empty document rather than a canvas with nothing behind it", async () => {
		const store = await load();
		const only = store.getState().architectures[0].id;

		store.getState().deleteArchitecture(only);

		expect(store.getState().architectures).toHaveLength(1);
		expect(store.getState().architectures[0].id).not.toBe(only);
		expect(store.getState().activeArchitectureId).toBe(
			store.getState().architectures[0].id,
		);
	});

	it("ignores a write aimed at a document that is not open", async () => {
		const store = await load();
		const before = store.getState().architectures;

		store.getState().updateArchitecture("not-a-document", {
			nodes: [{ id: "x" }] as never,
		});

		expect(store.getState().architectures).toEqual(before);
	});
});

// ── The timeline ──────────────────────────────────────────────────────

describe("construction history", () => {
	it("shows one right-hand dock at a time", async () => {
		const store = await load();

		store.getState().setDockOpen(true);
		store.getState().setHistoryOpen(true);
		expect(store.getState().dockOpen).toBe(false);
		expect(store.getState().historyOpen).toBe(true);

		store.getState().setDockOpen(true);
		expect(store.getState().historyOpen).toBe(false);
	});

	it("reads the timeline of the architecture that asked for it", async () => {
		const module = await import("../visual-to-code-store");
		const store = module.useVisualToCodeStore;
		const id = store.getState().architectures[0].id;
		historyApi.list.mockResolvedValueOnce({
			success: true,
			data: [{ id: "v1", label: null }],
		} as never);

		await module.loadHistory(id);

		expect(store.getState().versions).toEqual([{ id: "v1", label: null }]);
		expect(store.getState().historyLoading).toBe(false);
	});

	it("drops an answer that arrives after the user switched document", async () => {
		const module = await import("../visual-to-code-store");
		const store = module.useVisualToCodeStore;
		const first = store.getState().architectures[0].id;
		const second = store.getState().createArchitecture("Mobile");
		store.getState().setActiveArchitecture(second);

		historyApi.list.mockImplementationOnce(async () => {
			// The switch happens while the read is in flight.
			store.getState().setActiveArchitecture(first);
			return { success: true, data: [{ id: "stale" }] } as never;
		});
		await module.loadHistory(second);

		// Showing one document's timeline under another's name is how a restore
		// lands in the wrong architecture.
		expect(store.getState().versions).toEqual([]);
	});

	it("parks a restored version for the canvas, and hands it over once", async () => {
		const module = await import("../visual-to-code-store");
		const store = module.useVisualToCodeStore;
		const id = store.getState().architectures[0].id;
		historyApi.get.mockResolvedValueOnce({
			success: true,
			data: {
				id: "v1",
				diagramType: "flowchart",
				nodes: [{ id: "1" }],
				edges: [],
			},
		} as never);

		expect(await module.restoreVersion(id, "v1")).toBe(true);
		const pending = store.getState().pendingRestore;
		expect(pending).toMatchObject({ architectureId: id, versionId: "v1" });

		expect(store.getState().consumePendingRestore()).toBe(pending);
		// Taken exactly once, so a remount does not re-apply it.
		expect(store.getState().consumePendingRestore()).toBeNull();
	});

	it("says so rather than throwing when a version cannot be read", async () => {
		const module = await import("../visual-to-code-store");
		historyApi.get.mockResolvedValueOnce({ success: false } as never);

		expect(await module.restoreVersion("arch", "gone")).toBe(false);
		expect(module.useVisualToCodeStore.getState().pendingRestore).toBeNull();
	});

	it("does not interrupt editing when a step cannot be recorded", async () => {
		const module = await import("../visual-to-code-store");
		historyApi.append.mockRejectedValueOnce(new Error("disk full"));

		await expect(
			module.captureVersion("arch", {
				diagramType: "architecture",
				nodes: [],
				edges: [],
			}),
		).resolves.toBe(false);
	});
});
