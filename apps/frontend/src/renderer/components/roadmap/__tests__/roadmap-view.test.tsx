/** @vitest-environment jsdom */
/**
 * The roadmap view of a project: it loads the roadmap, asks about competitor
 * analysis before generating or refreshing, shows and stops a generation,
 * turns a feature into a task, and saves or deletes features. The store is
 * the real one; the main process is the electronAPI double. The kanban board
 * (its own lot) is a double that only saves.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Roadmap } from "../../../../shared/types";
import { useRoadmapStore } from "../../../stores/roadmap-store";
import { useTaskStore } from "../../../stores/task-store";
import { Roadmap as RoadmapView } from "../../Roadmap";
import { Toaster } from "../../ui/toaster";
import { TooltipProvider } from "../../ui/tooltip";
import { analysis, feature, roadmap } from "./fixtures";

vi.mock("../../RoadmapKanbanView", () => ({
	RoadmapKanbanView: ({ onSave }: { onSave?: () => void }) => (
		<button type="button" onClick={onSave}>
			kanban-save
		</button>
	),
}));

const api = {
	getRoadmapStatus: vi.fn(),
	loadRoadmapProgress: vi.fn(),
	getRoadmap: vi.fn(),
	saveRoadmap: vi.fn(),
	generateRoadmap: vi.fn(),
	refreshRoadmap: vi.fn(),
	stopRoadmap: vi.fn(),
	convertFeatureToSpec: vi.fn(),
};

const show = (rm: Roadmap | null) =>
	api.getRoadmap.mockResolvedValue(rm ? { success: true, data: rm } : { success: false });

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = new Proxy(api, {
		get: (target, key) => (key in target ? target[key as keyof typeof api] : vi.fn(() => () => undefined)),
	});
	api.getRoadmapStatus.mockResolvedValue({ success: true, data: { isRunning: false } });
	api.saveRoadmap.mockResolvedValue({ success: true });
	api.stopRoadmap.mockResolvedValue({ success: true });
	globalThis.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
	await i18n.changeLanguage("en");
	useRoadmapStore.setState({
		roadmap: null,
		competitorAnalysis: null,
		generationStatus: { phase: "idle", progress: 0, message: "" },
	});
	useTaskStore.setState({ tasks: [] });
});
afterEach(cleanup);

const renderView = (onGoToTask?: (id: string) => void) =>
	render(
		<TooltipProvider>
			<RoadmapView projectId="proj" onGoToTask={onGoToTask} />
			<Toaster />
		</TooltipProvider>,
	);

const openFeature = async (title: string) => {
	fireEvent.click(await screen.findByRole("tab", { name: /All Features/ }));
	fireEvent.click(screen.getByText(title));
};

describe("Roadmap view", () => {
	it("without a roadmap, asks whether to run a competitor analysis, then shows the generation until it is stopped", async () => {
		show(null);
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "Generate Roadmap" }));
		expect(api.getRoadmap).toHaveBeenCalledWith("proj");

		fireEvent.click(await screen.findByRole("button", { name: "Yes, Enable Analysis" }));
		expect(api.generateRoadmap).toHaveBeenCalledWith("proj", true, undefined);
		expect(await screen.findByTestId("roadmap-view")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(api.stopRoadmap).toHaveBeenCalledWith("proj"));
		expect(await screen.findByRole("button", { name: "Generate Roadmap" })).toBeInTheDocument();
	});

	it("generates without competitor analysis when it is declined", async () => {
		show(null);
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "Generate Roadmap" }));
		fireEvent.click(await screen.findByRole("button", { name: "No, Skip Analysis" }));
		expect(api.generateRoadmap).toHaveBeenCalledWith("proj", false, undefined);
	});

	it("with a saved analysis, offers to reuse it, run a new one or skip it, for a generation", async () => {
		useRoadmapStore.setState({ competitorAnalysis: analysis() });
		api.getRoadmap.mockResolvedValue({ success: true, data: null });
		// loadRoadmap clears the analysis when there is no roadmap: keep the one set above.
		api.getRoadmapStatus.mockReturnValue(new Promise(() => undefined));
		renderView();
		fireEvent.click(screen.getByRole("button", { name: "Generate Roadmap" }));
		fireEvent.click(await screen.findByRole("button", { name: /Use existing analysis/ }));
		expect(api.generateRoadmap).toHaveBeenLastCalledWith("proj", true, false);
	});

	it("refreshes a roadmap with the analysis choice the person makes", async () => {
		show(roadmap({ competitorAnalysis: analysis() }));
		renderView();
		const refresh = await screen.findByRole("button", { name: "Regenerate Roadmap" });

		fireEvent.click(refresh);
		fireEvent.click(await screen.findByRole("button", { name: /Run new analysis/ }));
		expect(api.refreshRoadmap).toHaveBeenLastCalledWith("proj", true, true);

		act(() => useRoadmapStore.setState({ generationStatus: { phase: "idle", progress: 0, message: "" } }));
		fireEvent.click(await screen.findByRole("button", { name: "Regenerate Roadmap" }));
		fireEvent.click(await screen.findByRole("button", { name: /Skip competitor analysis/ }));
		expect(api.refreshRoadmap).toHaveBeenLastCalledWith("proj", false, undefined);

		act(() => useRoadmapStore.setState({ generationStatus: { phase: "idle", progress: 0, message: "" } }));
		fireEvent.click(await screen.findByRole("button", { name: "Regenerate Roadmap" }));
		fireEvent.click(await screen.findByRole("button", { name: /Use existing analysis/ }));
		expect(api.refreshRoadmap).toHaveBeenLastCalledWith("proj", true, false);
	});

	it("refreshes a roadmap without analysis after asking whether to run one", async () => {
		show(roadmap());
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "Regenerate Roadmap" }));
		fireEvent.click(await screen.findByRole("button", { name: "Yes, Enable Analysis" }));
		expect(api.refreshRoadmap).toHaveBeenCalledWith("proj", true, undefined);
	});

	it("shows the competitor analysis and the pain points a feature answers", async () => {
		show(roadmap({ competitorAnalysis: analysis(), features: [feature("f1", { competitorInsightIds: ["pp2"] })] }));
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "Competitor Analysis" }));
		expect(await screen.findByText("Competitor Analysis Results")).toBeInTheDocument();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		await openFeature("Feature f1");
		expect(await screen.findByText("Addresses Competitor Pain Points")).toBeInTheDocument();
		expect(screen.getAllByText("No export").length).toBeGreaterThan(0);
	});

	it("opens the add-feature dialog", async () => {
		show(roadmap());
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "Add Feature" }));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("turns the open feature into a task and then offers to go to it", async () => {
		show(roadmap());
		api.convertFeatureToSpec.mockResolvedValue({ success: true, data: { id: "t1", specId: "spec-1", title: "Feature f1" } });
		const onGoToTask = vi.fn();
		renderView(onGoToTask);
		await openFeature("Feature f1");
		fireEvent.click(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		const goTo = await screen.findAllByRole("button", { name: "Go to Task" });
		expect(api.convertFeatureToSpec).toHaveBeenCalledWith("proj", "f1");
		expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(["t1"]);
		expect(useRoadmapStore.getState().roadmap?.features[0].linkedSpecId).toBe("spec-1");
		fireEvent.click(goTo[0]);
		expect(onGoToTask).toHaveBeenCalledWith("spec-1");
	});

	it("converts a feature that is not open without touching the open one, and goes nowhere without a handler", async () => {
		show(roadmap({ features: [feature("f1"), feature("f2")] }));
		api.convertFeatureToSpec.mockResolvedValue({ success: true, data: { id: "t2", specId: "spec-2" } });
		renderView();
		await openFeature("Feature f1");
		fireEvent.click(screen.getAllByRole("button", { name: "Build" })[1]);
		await waitFor(() => expect(useRoadmapStore.getState().roadmap?.features[1].linkedSpecId).toBe("spec-2"));
		expect(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Go to Task" }));
	});

	it("says so when a feature could not become a task", async () => {
		show(roadmap());
		api.convertFeatureToSpec
			.mockResolvedValueOnce({ success: false, error: "spec folder locked" })
			.mockResolvedValueOnce({ success: false });
		renderView();
		await openFeature("Feature f1");
		fireEvent.click(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		expect(await screen.findByText("The feature could not be turned into a task: spec folder locked")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Convert to WorkPilot AI Task" }));
		expect(await screen.findByText("The feature could not be turned into a task: unknown error")).toBeInTheDocument();
		expect(useTaskStore.getState().tasks).toEqual([]);
	});

	it("saves what the board changed, and reloads and says so when a save does not land", async () => {
		const rm = roadmap();
		show(rm);
		renderView();
		fireEvent.click(await screen.findByRole("button", { name: "kanban-save" }));
		await waitFor(() => expect(api.saveRoadmap).toHaveBeenCalledWith("proj", expect.objectContaining({ id: "rm" })));

		api.saveRoadmap.mockResolvedValueOnce({ success: false });
		const loads = api.getRoadmap.mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: "kanban-save" }));
		await waitFor(() => expect(api.getRoadmap.mock.calls.length).toBe(loads + 1));
		const refused = await screen.findByText("Failed to save roadmap");

		api.saveRoadmap.mockRejectedValueOnce(new Error("disk"));
		fireEvent.click(await screen.findByRole("button", { name: "kanban-save" }));
		// The failure brings a toast of its own in place of the first one.
		await waitFor(() => expect(screen.getByText("Failed to save roadmap")).not.toBe(refused));
	});

	it("writes nothing when the roadmap was cleared before the save", async () => {
		show(roadmap());
		renderView();
		const save = await screen.findByRole("button", { name: "kanban-save" });
		act(() => {
			useRoadmapStore.setState({ roadmap: null });
			fireEvent.click(save);
		});
		// Let any save the click started settle before checking none did.
		await act(() => Promise.resolve());
		expect(api.saveRoadmap).not.toHaveBeenCalled();
	});

	it("deletes a feature and saves the roadmap without it", async () => {
		show(roadmap({ features: [feature("f1"), feature("f2")] }));
		renderView();
		await openFeature("Feature f1");
		fireEvent.click(screen.getByRole("button", { name: "Delete feature" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(api.saveRoadmap).toHaveBeenCalled());
		expect(api.saveRoadmap.mock.calls[0][1].features.map((f: { id: string }) => f.id)).toEqual(["f2"]);
		expect(screen.queryByRole("button", { name: "Close feature details" })).not.toBeInTheDocument();
	});
});
