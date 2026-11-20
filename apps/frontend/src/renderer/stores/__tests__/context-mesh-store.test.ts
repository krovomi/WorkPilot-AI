/**
 * Context Mesh: the dialog, the mesh's lists read from the main process, the
 * changes a person makes to them, and starting and stopping an analysis.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteHandbookEntry,
	deletePattern,
	loadAllContextMeshData,
	loadContextMeshRecommendations,
	registerProject,
	startContextMeshAnalysis,
	stopContextMeshAnalysis,
	unregisterProject,
	updateRecommendationStatus,
	updateSkillTransferStatus,
	useContextMeshStore,
} from "../context-mesh-store";

const DATA: Record<string, unknown> = {
	"contextMesh:getProjects": [{ project_dir: "/a" }],
	"contextMesh:getPatterns": [{ pattern_id: "p1" }, { pattern_id: "p2" }],
	"contextMesh:getHandbook": [{ entry_id: "h1" }, { entry_id: "h2" }],
	"contextMesh:getSkillTransfers": [{ transfer_id: "s1", status: "pending" }, { transfer_id: "s2", status: "pending" }],
	"contextMesh:getRecommendations": [{ recommendation_id: "r1", status: "active" }, { recommendation_id: "r2", status: "active" }],
	"contextMesh:getSummary": { total_projects: 1 },
};
const invoke = vi.fn();
const send = vi.fn();
const state = () => useContextMeshStore.getState();
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	state().reset();
	invoke.mockReset().mockImplementation(async (channel: string) =>
		channel in DATA ? { success: true, data: DATA[channel] } : { success: true },
	);
	send.mockReset();
	errors = vi.spyOn(console, "error").mockReturnValue(undefined);
	(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, send };
});

describe("the dialog", () => {
	it("opens and closes on a clean run, keeping the tab", () => {
		state().setActiveTab("handbook");
		state().setError("old");
		state().openDialog();
		expect(state()).toMatchObject({ isOpen: true, phase: "idle", error: null, activeTab: "handbook" });
		state().appendStreamingOutput("x");
		state().closeDialog();
		expect(state()).toMatchObject({ isOpen: false, streamingOutput: "", status: "" });
	});
});

describe("reading the mesh", () => {
	it("loads every list at once", async () => {
		await loadAllContextMeshData();
		expect(state()).toMatchObject({
			projects: DATA["contextMesh:getProjects"],
			patterns: DATA["contextMesh:getPatterns"],
			handbookEntries: DATA["contextMesh:getHandbook"],
			skillTransfers: DATA["contextMesh:getSkillTransfers"],
			recommendations: DATA["contextMesh:getRecommendations"],
			summary: DATA["contextMesh:getSummary"],
			isLoading: false,
		});
	});

	it("asks for the recommendations of one project", async () => {
		await loadContextMeshRecommendations("/b");
		expect(invoke).toHaveBeenCalledWith("contextMesh:getRecommendations", "/b");
	});

	it("keeps what it had when a read is refused or fails", async () => {
		await loadAllContextMeshData();
		const before = state();
		invoke.mockResolvedValue({ success: false });
		await loadAllContextMeshData();
		invoke.mockRejectedValue(new Error("ipc closed"));
		await loadAllContextMeshData();
		expect(state()).toMatchObject({
			projects: before.projects,
			patterns: before.patterns,
			summary: before.summary,
			isLoading: false,
		});
		expect(errors).toHaveBeenCalledTimes(6);
	});
});

describe("changing the mesh", () => {
	beforeEach(() => loadAllContextMeshData());

	it("registers and unregisters a project, then reloads the projects and the summary", async () => {
		expect(await registerProject("/b")).toBe(true);
		expect(invoke).toHaveBeenCalledWith("contextMesh:registerProject", "/b");
		expect(await unregisterProject("/b")).toBe(true);
		expect(invoke).toHaveBeenCalledWith("contextMesh:unregisterProject", "/b");
		expect(invoke.mock.calls.filter(([c]) => c === "contextMesh:getSummary")).toHaveLength(3);
	});

	it("removes a pattern and a handbook entry", async () => {
		expect(await deletePattern("p1")).toBe(true);
		expect(await deleteHandbookEntry("h2")).toBe(true);
		expect(state().patterns.map((p) => p.pattern_id)).toEqual(["p2"]);
		expect(state().handbookEntries.map((e) => e.entry_id)).toEqual(["h1"]);
	});

	it("changes the status of one transfer and one recommendation", async () => {
		expect(await updateSkillTransferStatus("s2", "accepted")).toBe(true);
		expect(await updateRecommendationStatus("r1", "dismissed")).toBe(true);
		expect(invoke).toHaveBeenCalledWith("contextMesh:updateTransferStatus", "s2", "accepted");
		expect(state().skillTransfers.map((t) => t.status)).toEqual(["pending", "accepted"]);
		expect(state().recommendations.map((r) => r.status)).toEqual(["dismissed", "active"]);
	});

	const changes: Array<[string, () => Promise<boolean>]> = [
		["register", () => registerProject("/b")],
		["unregister", () => unregisterProject("/b")],
		["delete a pattern", () => deletePattern("p1")],
		["delete an entry", () => deleteHandbookEntry("h1")],
		["update a transfer", () => updateSkillTransferStatus("s1", "accepted")],
		["update a recommendation", () => updateRecommendationStatus("r1", "dismissed")],
	];

	it.each(changes)("reports a refused or failed %s, and changes nothing", async (_name, change) => {
		const before = state();
		invoke.mockResolvedValueOnce({ success: false });
		expect(await change()).toBe(false);
		invoke.mockRejectedValueOnce(new Error("ipc closed"));
		expect(await change()).toBe(false);
		expect(state().patterns).toBe(before.patterns);
		expect(state().handbookEntries).toBe(before.handbookEntries);
		expect(state().skillTransfers).toBe(before.skillTransfers);
		expect(state().recommendations).toBe(before.recommendations);
		expect(errors).toHaveBeenCalledOnce();
	});
});

describe("an analysis", () => {
	it("starts clean, without the last run's output or error", () => {
		state().setStatus("Comparing projects");
		state().appendStreamingOutput("last run");
		state().setError("backend unreachable");
		startContextMeshAnalysis("opus", "high");
		expect(send).toHaveBeenCalledWith("contextMesh:runAnalysis", "opus", "high");
		expect(state()).toMatchObject({ phase: "analyzing", status: "", streamingOutput: "", error: null });
	});

	it("stops", async () => {
		startContextMeshAnalysis();
		await stopContextMeshAnalysis();
		expect(invoke).toHaveBeenCalledWith("contextMesh:stopAnalysis");
		expect(state().phase).toBe("idle");
	});
});
