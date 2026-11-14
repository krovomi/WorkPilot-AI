/**
 * The Live Companion page: its actions create Kanban tasks (they used to flip
 * a status and touch no code), it shows why an analysis failed, and it says
 * when the companion watches another project than the open one.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CompanionState,
	LiveSuggestion,
	TakeoverProposal,
} from "../../../../shared/types/live-companion";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}|${JSON.stringify(options)}` : key,
		i18n: { language: "fr" },
	}),
}));

const createTask = vi.fn();
vi.mock("../../../stores/task-store", () => ({
	createTask: (...args: unknown[]) => createTask(...args),
}));

const project = { id: "p1", path: "/work/shop", name: "shop" };
vi.mock("../../../stores/project-store", () => ({
	useProjectStore: Object.assign(
		(select: (s: unknown) => unknown) => select({ getActiveProject: () => project }),
		{ getState: () => ({ getActiveProject: () => project }) },
	),
}));

import { useLiveCompanionStore } from "../../../stores/live-companion-store";
import { suggestionTask, takeoverTask } from "../companion-tasks";
import { LiveCompanionDashboard } from "../LiveCompanionDashboard";

const IDLE: CompanionState = {
	active: false,
	watching_project: "",
	files_watched: 0,
	changes_detected: 0,
	suggestions_generated: 0,
	suggestions_accepted: 0,
	takeovers_proposed: 0,
	takeovers_accepted: 0,
	started_at: "",
	last_change_at: "",
	analyzing: false,
	last_error: null,
};

const SUGGESTION: LiveSuggestion = {
	suggestion_id: "sug-1",
	suggestion_type: "bug_detection",
	priority: "high",
	title: "Null check missing",
	description: "order.customer may be null.",
	file_path: "src/Orders/OrderService.cs",
	line_start: 12,
	line_end: 14,
	code_fix: "if (order.Customer is null) return;",
	related_files: ["src/Orders/IOrderService.cs"],
	confidence: 0.82,
	created_at: "2026-11-14T10:00:00Z",
	status: "active",
	project_dir: "/work/shop",
};

const PROPOSAL: TakeoverProposal = {
	proposal_id: "tkv-1",
	file_path: "lib/cart.dart",
	reason: "inactivity",
	description: "",
	inactivity_seconds: 185,
	complexity_score: 0,
	status: "proposed",
	ai_plan: "",
	ai_result_summary: "",
	created_at: "2026-11-14T10:00:00Z",
	change_count: 5,
	project_dir: "/work/shop",
};

let state: CompanionState;
const api = {
	liveCompanionGetState: vi.fn(async () => ({ success: true, data: state })),
	liveCompanionGetConfig: vi.fn(async () => ({ success: false })),
	liveCompanionGetSuggestions: vi.fn(async () => ({ success: true, data: [SUGGESTION] })),
	liveCompanionGetTakeovers: vi.fn(async () => ({ success: true, data: [PROPOSAL] })),
	liveCompanionApplySuggestion: vi.fn(async () => ({ success: true })),
	liveCompanionAcceptTakeover: vi.fn(async () => ({ success: true })),
	liveCompanionStart: vi.fn(async () => ({ success: true })),
};

beforeEach(() => {
	vi.clearAllMocks();
	state = { ...IDLE };
	useLiveCompanionStore.getState().reset();
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("LiveCompanionDashboard", () => {
	it("turns a suggestion into a Kanban task, then marks it handled", async () => {
		createTask.mockResolvedValue({ id: "t1" });
		render(<LiveCompanionDashboard />);

		await screen.findByText("Null check missing");
		await userEvent.click(screen.getByText("liveCompanion:actions.createTask"));

		await waitFor(() => expect(api.liveCompanionApplySuggestion).toHaveBeenCalledWith("sug-1"));
		const [projectId, title, description] = createTask.mock.calls[0];
		expect(projectId).toBe("p1");
		expect(title).toContain("Null check missing");
		expect(description).toContain("if (order.Customer is null) return;");
		expect(screen.getByText("liveCompanion:task.created")).toBeTruthy();
		// Suggestions and proposals are loaded for the open project only.
		expect(api.liveCompanionGetSuggestions).toHaveBeenCalledWith("/work/shop");
		expect(api.liveCompanionGetTakeovers).toHaveBeenCalledWith("/work/shop");
	});

	it("keeps the suggestion when the task could not be created", async () => {
		createTask.mockResolvedValue(null);
		render(<LiveCompanionDashboard />);

		await screen.findByText("Null check missing");
		await userEvent.click(screen.getByText("liveCompanion:actions.createTask"));

		await screen.findByText("liveCompanion:task.failed");
		expect(api.liveCompanionApplySuggestion).not.toHaveBeenCalled();
	});

	it("turns a takeover proposal into a Kanban task", async () => {
		createTask.mockResolvedValue({ id: "t2" });
		render(<LiveCompanionDashboard />);

		await userEvent.click(await screen.findByText("liveCompanion:takeover.accept"));

		await waitFor(() => expect(api.liveCompanionAcceptTakeover).toHaveBeenCalledWith("tkv-1"));
		expect(createTask.mock.calls[0][1]).toContain("cart.dart");
		// The reason is translated, not shown raw.
		expect(screen.queryByText("inactivity")).toBeNull();
	});

	it("shows why the last analysis failed", async () => {
		state = {
			...IDLE,
			active: true,
			watching_project: "/work/shop",
			last_error: {
				message: "invalid api key",
				code: "auth_failed",
				provider: "mistral",
				at: "2026-11-14T10:00:00Z",
			},
		};
		render(<LiveCompanionDashboard />);

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/invalid api key/)).toBeTruthy();
		expect(screen.getByText(/auth_failed/)).toBeTruthy();
	});

	it("says when another project is watched and offers to switch", async () => {
		state = { ...IDLE, active: true, watching_project: "/work/other" };
		render(<LiveCompanionDashboard />);

		await userEvent.click(await screen.findByText("liveCompanion:actions.watchThis"));

		expect(api.liveCompanionStart).toHaveBeenCalledWith("/work/shop");
	});
});

describe("companion tasks", () => {
	const t = ((key: string, options?: Record<string, unknown>) =>
		options ? `${key}|${JSON.stringify(options)}` : key) as never;

	it("carries the file, lines, related files and fix of a suggestion", () => {
		const task = suggestionTask(t, SUGGESTION);
		expect(task.title).toContain("OrderService.cs");
		expect(task.description).toContain("src/Orders/OrderService.cs");
		expect(task.description).toContain('"start":12,"end":14');
		expect(task.description).toContain("src/Orders/IOrderService.cs");
		expect(task.description).toContain("```");
	});

	it("keeps a title on one short line", () => {
		const task = suggestionTask(t, { ...SUGGESTION, title: `long\n${"x".repeat(300)}` });
		expect(task.title.length).toBeLessThanOrEqual(120);
		expect(task.title).not.toContain("\n");
	});

	it("names the file of a takeover", () => {
		const task = takeoverTask(t, PROPOSAL);
		expect(task.title).toContain("cart.dart");
		expect(task.description).toContain('"count":5');
		expect(task.description).toContain("lib/cart.dart");
	});
});
