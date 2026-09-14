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

beforeEach(() => {
	vi.resetModules();
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
