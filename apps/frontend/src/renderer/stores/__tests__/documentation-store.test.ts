/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DocFileReport,
	DocumentationRequest,
} from "../../../shared/types/documentation";
import {
	setupDocumentationListeners,
	useDocumentationStore,
} from "../documentation-store";

const api = {
	runDocumentation: vi.fn(),
	cancelDocumentation: vi.fn(),
	onDocumentationProgress: vi.fn(),
};

const FILE: DocFileReport = {
	path: "src/a.ts",
	language: "typescript",
	symbols: [],
	total: 1,
	documented: 1,
	partial: 0,
	missing: 0,
	coverage_pct: 100,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const store = () => useDocumentationStore.getState();

describe("documentation store", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(globalThis.electronAPI, api);
		useDocumentationStore.setState({
			projectPath: null,
			running: null,
			status: "",
			error: null,
			overview: null,
			file: null,
			drafts: null,
			readme: null,
			selectedSymbol: null,
			draftsView: "docs",
		});
	});

	it("does nothing without a project", async () => {
		await store().run("project");
		expect(api.runDocumentation).not.toHaveBeenCalled();
	});

	it("keeps its reports for the same project and clears them for another", () => {
		store().bindProject("/p");
		useDocumentationStore.setState({ file: FILE, error: "x" });

		store().bindProject("/p");
		expect(store().file).toBe(FILE);

		store().bindProject("/q");
		expect(store()).toMatchObject({ projectPath: "/q", file: null, error: null });
	});

	it("runs each action and stores its result", async () => {
		store().bindProject("/p");
		const overview = { total: 3 };
		const drafts = { generated_docs: [] };
		const readme = { readme_content: "# A" };
		api.runDocumentation.mockImplementation(async (req: DocumentationRequest) =>
			({ project: overview, coverage: FILE, docstrings: drafts, readme })[req.action],
		);

		await store().run("project");
		expect(store().overview).toBe(overview);

		store().selectSymbol("x:1");
		await store().run("coverage", "src/a.ts");
		expect(store()).toMatchObject({ file: FILE, selectedSymbol: null });

		store().setDraftsView("readme");
		await store().run("docstrings", "src/a.ts");
		expect(store()).toMatchObject({ drafts, draftsView: "docs" });
		// The file was already read: only the drafts are asked for.
		expect(api.runDocumentation).toHaveBeenLastCalledWith({
			projectPath: "/p",
			action: "docstrings",
			path: "src/a.ts",
		});
		expect(api.runDocumentation).toHaveBeenCalledTimes(3);

		await store().run("readme", "src");
		expect(store()).toMatchObject({ readme, draftsView: "readme", running: null });
	});

	it("reads the file along with the drafts of another file", async () => {
		store().bindProject("/p");
		api.runDocumentation.mockImplementation(async (req: DocumentationRequest) =>
			req.action === "coverage" ? { ...FILE, path: "src/b.ts" } : { generated_docs: [] },
		);

		await store().run("docstrings", "src/b.ts");

		expect(store().file?.path).toBe("src/b.ts");
		expect(api.runDocumentation).toHaveBeenCalledWith({
			projectPath: "/p",
			action: "coverage",
			path: "src/b.ts",
		});
	});

	it.each([
		["project", "overview"],
		["coverage", "file"],
		["docstrings", "drafts"],
		["readme", "readme"],
	] as const)("drops a %s result that arrives for a project left behind", async (action, field) => {
		store().bindProject("/p");
		const pending = deferred<unknown>();
		api.runDocumentation.mockReturnValue(pending.promise);

		const run = store().run(action, "x");
		store().bindProject("/q");
		pending.resolve({ generated_docs: [] });
		await run;

		expect(store()[field]).toBeNull();
	});

	it("shows the reason of a failure without the IPC prefix", async () => {
		store().bindProject("/p");
		api.runDocumentation.mockRejectedValueOnce(
			new Error("Error invoking remote method 'doc:run': Error: runner crashed"),
		);
		await store().run("project");
		expect(store()).toMatchObject({ error: "runner crashed", running: null });

		api.runDocumentation.mockRejectedValueOnce("plain reason");
		await store().run("project");
		expect(store().error).toBe("plain reason");
	});

	it("keeps the failure of a project left behind out of the new one", async () => {
		store().bindProject("/p");
		const pending = deferred<unknown>();
		api.runDocumentation.mockReturnValue(pending.promise);

		const run = store().run("project");
		store().bindProject("/q");
		pending.reject(new Error("boom"));
		await run;

		expect(store().error).toBeNull();
	});

	it("cancels the run", async () => {
		useDocumentationStore.setState({ running: "project", status: "Reading" });
		await store().cancel();
		expect(api.cancelDocumentation).toHaveBeenCalled();
		expect(store()).toMatchObject({ running: null, status: "" });
	});

	describe("progress listener", () => {
		it("shows a progress line while a run goes on, and drops it after", () => {
			const unsubscribe = vi.fn();
			api.onDocumentationProgress.mockReturnValue(unsubscribe);

			expect(setupDocumentationListeners()).toBe(unsubscribe);
			const listener = api.onDocumentationProgress.mock.calls[0][0];

			useDocumentationStore.setState({ running: "project" });
			listener("Reading 3/10");
			expect(store().status).toBe("Reading 3/10");

			useDocumentationStore.setState({ running: null, status: "" });
			listener("late line");
			expect(store().status).toBe("");
		});

		it("registers nothing when the API has no progress channel", () => {
			const saved = globalThis.electronAPI.onDocumentationProgress;
			Reflect.deleteProperty(globalThis.electronAPI, "onDocumentationProgress");
			try {
				expect(setupDocumentationListeners()).toBeUndefined();
			} finally {
				Object.assign(globalThis.electronAPI, { onDocumentationProgress: saved });
			}
		});
	});
});
