/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { BestOfNState, Task } from "../../../shared/types";

vi.mock("../task-engine/EngineTrioPicker", () => ({
	EngineTrioPicker: ({ value }: { value: { provider: string } }) => (
		<div data-testid="picker">{value.provider}</div>
	),
}));
vi.mock("../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({ providers: [{ name: "openai", label: "OpenAI" }], loading: false }),
}));
const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../../stores/task-store", () => ({ loadTasks }));

import { BestOfNCard } from "./BestOfNCard";

const task: Task = {
	id: "001-login",
	specId: "001-login",
	projectId: "project-1",
	title: "Login",
	description: "",
	status: "backlog",
	subtasks: [],
	logs: [],
	metadata: {
		engineLocked: true,
		provider: "openai",
		model: "model-b",
		thinkingLevel: "medium",
	} as Task["metadata"],
	createdAt: new Date("2026-10-26T08:00:00.000Z"),
	updatedAt: new Date("2026-10-26T09:00:00.000Z"),
};

const engineA = { provider: "anthropic", model: "model-a", effort: "high" } as never;
const engineB = { provider: "openai", model: "model-b", effort: "medium" } as never;

function score(index: number, extra: object) {
	return {
		spec_id: `001-login-bon${index}`,
		index,
		engine: index === 1 ? engineA : engineB,
		exit_code: 0,
		worktree: true,
		subtasks_done: 3,
		subtasks_total: 3,
		build_complete: true,
		qa_status: "approved",
		goal_status: null,
		goal_reason: "",
		diff_lines: 5,
		diff_files: 1,
		cost_usd: 1,
		cost_complete: true,
		rank: index,
		...extra,
	};
}

const ranked: BestOfNState = {
	parent: "001-login",
	phase: "ranked",
	createdAt: "x",
	variants: [],
	ranking: {
		criteria: ["build", "tests", "diff"],
		skipped: { goal: "no_goal", cost: "cost_partial" },
		recommended: "001-login-bon1",
		at: "x",
		variants: [score(1, {}), score(2, { diff_lines: 40, diff_files: 3, cost_complete: false })],
	},
};

const api = {
	getBestOfNStatus: vi.fn(),
	onBestOfNEvent: vi.fn(() => () => undefined),
	startBestOfN: vi.fn(),
	adoptBestOfN: vi.fn(),
	rankBestOfN: vi.fn(),
	discardBestOfN: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

describe("BestOfNCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getBestOfNStatus.mockResolvedValue({ success: true, data: { state: null, running: [] } });
		api.startBestOfN.mockResolvedValue({ success: true, data: { state: null, running: [] } });
		api.adoptBestOfN.mockResolvedValue({
			success: true,
			data: { state: { ...ranked, phase: "adopted" }, running: [] },
		});
	});

	it("builds the task once per engine, seeded with the task's own", async () => {
		render(<BestOfNCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Set up" }));
		expect(screen.getAllByTestId("picker")).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Add a variant" }));
		fireEvent.click(screen.getByRole("button", { name: "Build 3 variants" }));
		await waitFor(() => expect(api.startBestOfN).toHaveBeenCalledTimes(1));
		const [taskId, engines] = api.startBestOfN.mock.calls[0];
		expect(taskId).toBe("001-login");
		expect(engines).toHaveLength(3);
		expect(engines[0]).toMatchObject({ provider: "openai", model: "model-b" });
	});

	it("is not offered once the task has a build of its own", () => {
		const { container } = render(<BestOfNCard task={{ ...task, status: "human_review" }} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the numbers it ranked on, and what it left out", async () => {
		api.getBestOfNStatus.mockResolvedValue({ success: true, data: { state: ranked, running: [] } });
		render(<BestOfNCard task={{ ...task, status: "human_review" }} />);
		expect(await screen.findByText("5 lines, 1 files")).toBeInTheDocument();
		expect(screen.getByText("40 lines, 3 files")).toBeInTheDocument();
		expect(screen.getByText("≥ $1.00")).toBeInTheDocument();
		expect(screen.getByText("Ranked on: Build › Tests (QA) › Diff")).toBeInTheDocument();
		expect(screen.getByText(/the cost ranks nobody/)).toBeInTheDocument();
		expect(screen.getByLabelText("Ranks first alone")).toBeInTheDocument();
	});

	it("adopts only after the person confirms", async () => {
		api.getBestOfNStatus.mockResolvedValue({ success: true, data: { state: ranked, running: [] } });
		render(<BestOfNCard task={{ ...task, status: "human_review" }} />);
		const keep = await screen.findAllByRole("button", { name: "Keep this one" });
		fireEvent.click(keep[1]);
		expect(api.adoptBestOfN).not.toHaveBeenCalled();
		expect(await screen.findByText("Keep this build?")).toBeInTheDocument();
		const confirm = screen.getAllByRole("button", { name: "Keep this one" }).at(-1);
		fireEvent.click(confirm as HTMLElement);
		await waitFor(() => expect(api.adoptBestOfN).toHaveBeenCalledWith("001-login", "001-login-bon2"));
		await waitFor(() => expect(loadTasks).toHaveBeenCalledWith("project-1", { forceRefresh: true }));
	});
});
