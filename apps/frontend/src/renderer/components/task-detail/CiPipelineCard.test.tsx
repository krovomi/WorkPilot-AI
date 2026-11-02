/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task, TaskPipelineStatus } from "../../../shared/types";
import { useTaskStore } from "../../stores/task-store";
import { CiPipelineCard } from "./CiPipelineCard";

const task = { id: "t1", specId: "001" } as unknown as Task;
const red: TaskPipelineStatus = {
	taskId: "t1",
	projectId: "p1",
	state: "failed",
	providerLabel: "GitHub Actions",
	buildNumber: "#42",
	branch: "workpilot/001",
	checkedAt: "2026-11-02T08:00:00Z",
};

const api = { fixRedBuild: vi.fn(), openExternal: vi.fn() };
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

beforeEach(async () => {
	await i18n.changeLanguage("en");
	vi.clearAllMocks();
	api.fixRedBuild.mockResolvedValue({ success: true });
	useTaskStore.setState({ pipelineStatuses: {} });
});
afterEach(cleanup);

describe("CiPipelineCard", () => {
	it("renders nothing when no run is known for the branch", () => {
		const { container, rerender } = render(<CiPipelineCard task={task} />);
		expect(container).toBeEmptyDOMElement();
		useTaskStore.setState({ pipelineStatuses: { t1: { ...red, state: "none" } } });
		rerender(<CiPipelineCard task={task} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a red run and repairs it by the task id", async () => {
		useTaskStore.setState({ pipelineStatuses: { t1: red } });
		render(<CiPipelineCard task={task} />);
		expect(screen.getByText("Red")).toBeInTheDocument();
		expect(screen.getByText("GitHub Actions #42 on workpilot/001")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Repair build" }));
		await waitFor(() => expect(api.fixRedBuild).toHaveBeenCalledWith("t1"));
	});

	it("opens the run on the CI provider", () => {
		useTaskStore.setState({ pipelineStatuses: { t1: { ...red, webUrl: "https://ci.example/run/42" } } });
		render(<CiPipelineCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Open the run" }));
		expect(api.openExternal).toHaveBeenCalledWith("https://ci.example/run/42");
	});

	it("offers no repair on a green run", () => {
		useTaskStore.setState({ pipelineStatuses: { t1: { ...red, state: "succeeded" } } });
		render(<CiPipelineCard task={task} />);
		expect(screen.getByText("Green")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Repair build" })).toBeNull();
	});
});
