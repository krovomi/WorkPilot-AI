/**
 * What a task changed in the architecture: read per task, regenerated on
 * demand, followed through the runner's events, and never shown on a card
 * that moved on while an answer was out.
 *
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	setupArchitectureDeltaListeners,
	shouldShowArchitectureDelta,
	useArchitectureDelta,
	useArchitectureDeltaStore,
} from "../architecture-delta-store";

type Listener = (value: unknown) => void;
const listeners = new Map<string, Listener>();
let api: Record<string, ReturnType<typeof vi.fn>>;
let teardown: () => void;

const mapped = (artifact: string | null = "/spec/delta.html", hasChanges = true) =>
	({ status: "mapped", hasChanges, artifact }) as never;

function deferred<T>() {
	let resolve: (value: T) => void = vi.fn();
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

beforeEach(() => {
	teardown?.();
	listeners.clear();
	useArchitectureDeltaStore.setState({ byTask: {} });
	const on = (name: string) =>
		vi.fn((callback: Listener) => {
			listeners.set(name, callback);
			return () => listeners.delete(name);
		});
	api = {
		readArchitectureDelta: vi.fn().mockResolvedValue({ success: true, data: mapped() }),
		regenerateArchitectureDelta: vi.fn().mockResolvedValue({ success: true }),
		resolveArchitectureArtifact: vi.fn().mockResolvedValue({ success: true, data: { url: "file:///spec/delta.html" } }),
		onArchitectureDeltaStatus: on("status"),
		onArchitectureVisualizerStreamChunk: on("chunk"),
		onArchitectureVisualizerError: on("error"),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	teardown = setupArchitectureDeltaListeners();
});

const entry = (taskId = "t1") => useArchitectureDeltaStore.getState().byTask[taskId];
const { load, regenerate, clear } = useArchitectureDeltaStore.getState();

describe("loading a task's delta", () => {
	it("shows the status and the artifact of a mapped delta with changes", async () => {
		await load({ taskId: "t1", specDir: "/spec" });
		expect(api.readArchitectureDelta).toHaveBeenCalledWith("/spec");
		expect(api.resolveArchitectureArtifact).toHaveBeenCalledWith("/spec/delta.html");
		expect(entry()).toMatchObject({ loading: false, error: null, artifactUrl: "file:///spec/delta.html" });
	});

	it("has no artifact for any other state, or when it cannot be resolved", async () => {
		api.readArchitectureDelta.mockResolvedValueOnce({ success: true, data: mapped("/a", false) });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry().artifactUrl).toBeNull();
		api.readArchitectureDelta.mockResolvedValueOnce({ success: true });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry()).toMatchObject({ status: null, artifactUrl: null });
		api.resolveArchitectureArtifact.mockResolvedValueOnce({ success: false });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry().artifactUrl).toBeNull();
		api.resolveArchitectureArtifact.mockResolvedValueOnce({ success: true });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry().artifactUrl).toBeNull();
		expect(api.resolveArchitectureArtifact).toHaveBeenCalledTimes(2);
	});

	it("says why it could not be read", async () => {
		api.readArchitectureDelta.mockResolvedValueOnce({ success: false, error: "no spec" });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry()).toMatchObject({ loading: false, error: "no spec" });
		api.readArchitectureDelta.mockResolvedValueOnce({ success: false });
		await load({ taskId: "t1", specDir: "/spec" });
		expect(entry().error).toBe("unknown error");
	});

	it("keeps only the answer of the last load", async () => {
		const first = deferred<unknown>();
		api.readArchitectureDelta.mockReturnValueOnce(first.promise);
		const stale = load({ taskId: "t1", specDir: "/old" });
		api.readArchitectureDelta.mockResolvedValueOnce({ success: true, data: mapped(null) });
		await load({ taskId: "t1", specDir: "/new" });
		first.resolve({ success: true, data: mapped() });
		await stale;
		expect(entry()).toMatchObject({ status: { artifact: null }, artifactUrl: null });
		expect(api.resolveArchitectureArtifact).not.toHaveBeenCalled();
	});

	it("does not bring back a card closed while its artifact was resolving", async () => {
		const url = deferred<unknown>();
		api.resolveArchitectureArtifact.mockReturnValueOnce(url.promise);
		const loading = load({ taskId: "t1", specDir: "/spec" });
		await vi.waitFor(() => expect(api.resolveArchitectureArtifact).toHaveBeenCalled());
		clear("t1");
		url.resolve({ success: true, data: { url: "file:///late" } });
		await loading;
		expect(entry()).toBeUndefined();
	});
});

describe("regenerating", () => {
	const args = { taskId: "t1", projectDir: "/p", specDir: "/spec", changedFiles: ["a.ts"], taskSummary: "s" };

	it("asks the main process for a forced run, streams its log and ends on the new status", async () => {
		await regenerate(args);
		expect(api.regenerateArchitectureDelta).toHaveBeenCalledWith({
			projectDir: "/p",
			specDir: "/spec",
			changedFiles: ["a.ts"],
			taskSummary: "s",
			force: true,
		});
		expect(entry()).toMatchObject({ running: true, progress: "" });
		listeners.get("chunk")?.("step 1\n");
		listeners.get("chunk")?.("step 2\n");
		expect(entry().progress).toBe("step 1\nstep 2\n");

		listeners.get("status")?.(mapped());
		expect(entry()).toMatchObject({ running: false, status: { status: "mapped" } });
		await vi.waitFor(() => expect(entry().artifactUrl).toBe("file:///spec/delta.html"));
	});

	it("drops the artifact of the last run when the new one has none", async () => {
		await load({ taskId: "t1", specDir: "/spec" });
		await regenerate(args);
		listeners.get("status")?.({ status: "not-significant", hasChanges: false, artifact: null });
		await vi.waitFor(() => expect(entry().artifactUrl).toBeNull());
	});

	it("ends on the runner's error", async () => {
		await regenerate(args);
		listeners.get("error")?.("archify crashed");
		expect(entry()).toMatchObject({ running: false, error: "archify crashed" });
		listeners.get("chunk")?.("late");
		expect(entry().progress).toBe("");
	});

	it("says why the run could not start, and then listens to nothing", async () => {
		api.regenerateArchitectureDelta.mockResolvedValueOnce({ success: false, error: "busy" });
		await regenerate(args);
		expect(entry()).toMatchObject({ running: false, error: "busy" });
		api.regenerateArchitectureDelta.mockResolvedValueOnce({ success: false });
		await regenerate(args);
		expect(entry().error).toBe("could not start the comparison");

		listeners.get("status")?.(mapped());
		listeners.get("chunk")?.("x");
		listeners.get("error")?.("x");
		expect(entry()).toMatchObject({ status: null, progress: "", error: "could not start the comparison" });
	});

	it("lets a closed card's run end without bringing the card back", async () => {
		await regenerate(args);
		clear("t1");
		listeners.get("status")?.(mapped());
		expect(entry()).toBeUndefined();
	});

	it("ignores output for an entry that is not running", async () => {
		await regenerate(args);
		useArchitectureDeltaStore.setState({ byTask: { t1: { ...entry(), running: false } } });
		const before = entry();
		listeners.get("chunk")?.("x");
		listeners.get("error")?.("x");
		expect(entry()).toBe(before);
	});

	it("drops its three listeners on teardown", () => {
		teardown();
		expect(listeners.size).toBe(0);
	});
});

describe("the task modal's hook", () => {
	it("loads the task's delta, and clears it on close", async () => {
		const { result, unmount } = renderHook(() => useArchitectureDelta("t1", "/spec"));
		await vi.waitFor(() => expect(result.current?.artifactUrl).toBe("file:///spec/delta.html"));
		unmount();
		expect(entry()).toBeUndefined();
	});

	it("loads nothing without a spec", () => {
		const { result } = renderHook(() => useArchitectureDelta("t1", undefined));
		expect(result.current).toBeUndefined();
		expect(api.readArchitectureDelta).not.toHaveBeenCalled();
	});
});

describe("whether the delta gets a tab", () => {
	const base = { loading: false, running: false, error: null, artifactUrl: null, progress: "" };
	it.each([
		["no record", undefined, false],
		["a run in progress", { ...base, status: null, running: true }, true],
		["no status yet", { ...base, status: null }, false],
		["a change that is not architectural", { ...base, status: { status: "not-significant" } }, false],
		["a comparison with no difference", { ...base, status: mapped(null, false) }, false],
		["a comparison with differences", { ...base, status: mapped() }, true],
		["any other state", { ...base, status: { status: "no-baseline" } }, true],
	])("%s", (_name, value, shown) => {
		expect(shouldShowArchitectureDelta(value as never)).toBe(shown);
	});
});
