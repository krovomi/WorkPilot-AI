/**
 * Sharing a replay (#347) in the Replay view: import from the list, export
 * from an open session with the options the person picks, and bookmarks on
 * the steps of a finished session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ReplaySessionFull,
	type ReplayStep,
	useAgentReplayStore,
} from "../../../stores/agent-replay-store";
import { useReplayShareStore } from "../../../stores/replay-share-store";
import { AgentReplayDashboard } from "../AgentReplayDashboard";
import { ReplayBookmarks } from "../ReplaySharing";

const api = {
	listReplaySessions: vi.fn(async () => ({ success: true, sessions: [] })),
	getReplayHeatmap: vi.fn(async () => ({ success: true, heatmap: [] })),
	exportReplaySession: vi.fn(),
	importReplaySession: vi.fn(),
	addReplayBookmark: vi.fn(),
	removeReplayBookmark: vi.fn(),
	getReplayUsage: vi.fn(async () => ({ success: false, error: "none" })),
	getReplayTeamUsage: vi.fn(async () => null),
};

function step(index: number): ReplayStep {
	return {
		id: `st${index}`,
		step_index: index,
		step_type: "tool_call",
		timestamp: 1,
		duration_ms: 5,
		label: `Step label ${index}`,
		description: "",
		reasoning: "",
		tool_name: null,
		tool_input: null,
		tool_output: null,
		file_diffs: [],
		input_tokens: 0,
		output_tokens: 0,
		cumulative_tokens: 0,
		cost_usd: 0,
		cumulative_cost_usd: 0,
		decision_node_id: null,
		parent_step_id: null,
		children_step_ids: [],
		options_considered: [],
		chosen_option: null,
		is_breakpoint: false,
		breakpoint_id: null,
	};
}

function session(extra: Partial<ReplaySessionFull> = {}): ReplaySessionFull {
	return {
		session_id: "s1",
		agent_name: "Bot",
		agent_role: "coder",
		provider: "ollama",
		model_label: "",
		task_description: "Fix",
		start_time: 1,
		end_time: 2,
		duration_seconds: 1,
		step_count: 2,
		total_tokens: 0,
		total_cost_usd: 0,
		total_tool_calls: 0,
		total_file_changes: 0,
		status: "completed",
		tags: [],
		agent_id: null,
		model: "",
		project_path: "",
		steps: [step(4), step(7)],
		breakpoints: [],
		files_touched: [],
		file_heatmap: {},
		tool_usage_stats: {},
		token_timeline: [],
		...extra,
	};
}

beforeEach(() => {
	vi.stubGlobal("electronAPI", api);
	Object.assign(window, { electronAPI: api });
	for (const fn of [api.exportReplaySession, api.importReplaySession, api.addReplayBookmark, api.removeReplayBookmark]) {
		fn.mockReset();
	}
	useReplayShareStore.setState({ exporting: false, importing: false, savingBookmark: false, notice: null });
	useAgentReplayStore.setState({
		sessions: [],
		sessionsLoading: false,
		activeSession: null,
		activeSessionLoading: false,
		currentStepIndex: 0,
		error: null,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the session list", () => {
	it("imports a replay and says whose it is", async () => {
		api.importReplaySession.mockResolvedValue({
			success: true,
			session: { session_id: "n1", agent_name: "Ana's bot" },
		});
		render(<AgentReplayDashboard />);

		fireEvent.click(screen.getByRole("button", { name: "Import a replay" }));

		expect(await screen.findByText("Imported the session of Ana's bot")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Imported the session of Ana's bot")).not.toBeInTheDocument();
	});
});

describe("an open session", () => {
	it("exports with the options picked and says where", async () => {
		api.exportReplaySession.mockResolvedValue({ success: true, filePath: "/out/r.wpreplay" });
		useAgentReplayStore.setState({ activeSession: session() });
		render(<AgentReplayDashboard />);

		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		expect(screen.getByText(/always masked before the file is written/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("switch", { name: "Remove the reasoning" }));
		fireEvent.click(screen.getByRole("button", { name: "Export .wpreplay" }));

		await waitFor(() => expect(api.exportReplaySession).toHaveBeenCalled());
		expect(api.exportReplaySession).toHaveBeenCalledWith("s1", {
			format: "wpreplay",
			stripReasoning: true,
			stripTokens: false,
			includeFileContents: false,
			language: "en",
		});
		expect(await screen.findByText("Saved to /out/r.wpreplay")).toBeInTheDocument();
	});

	it("exports a page", async () => {
		api.exportReplaySession.mockResolvedValue({ success: false, error: "boom" });
		useAgentReplayStore.setState({ activeSession: session() });
		render(<AgentReplayDashboard />);

		fireEvent.click(screen.getByRole("button", { name: "Share" }));
		fireEvent.click(screen.getByRole("button", { name: "Export a page (HTML)" }));

		expect(await screen.findByText("The replay could not be shared: boom")).toBeInTheDocument();
		expect(api.exportReplaySession.mock.calls[0][1].format).toBe("html");
	});

	it("bookmarks the current step and goes back to it", async () => {
		const mark = { id: "b1", step_index: 7, note: "**weird** choice", author: "", created_at: 1 };
		api.addReplayBookmark.mockResolvedValue({ success: true, bookmark: mark });
		useAgentReplayStore.setState({ activeSession: session(), currentStepIndex: 1 });
		render(<AgentReplayDashboard />);

		expect(screen.getByText("No bookmark yet.")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox", { name: "Bookmark note" }), {
			target: { value: "  **weird** choice " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Bookmark step 7" }));

		expect(await screen.findByText("**weird** choice")).toBeInTheDocument();
		expect(api.addReplayBookmark).toHaveBeenCalledWith("s1", {
			stepIndex: 7,
			note: "**weird** choice",
		});
		expect(screen.getByRole("textbox", { name: "Bookmark note" })).toHaveValue("");

		useAgentReplayStore.setState({ currentStepIndex: 0 });
		fireEvent.click(await screen.findByRole("button", { name: "Step 7" }));
		expect(useAgentReplayStore.getState().currentStepIndex).toBe(1);
	});

	it("keeps the note when the bookmark is refused, and removes one", async () => {
		const mark = { id: "b1", step_index: 4, note: "n", author: "Ana", created_at: 1 };
		api.addReplayBookmark.mockResolvedValue({ success: false, error: "boom" });
		api.removeReplayBookmark.mockResolvedValue({ success: true });
		useAgentReplayStore.setState({ activeSession: session({ bookmarks: [mark] }) });
		render(<AgentReplayDashboard />);

		expect(screen.getByText("Ana")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox", { name: "Bookmark note" }), {
			target: { value: "keep me" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Bookmark step 4" }));
		await waitFor(() => expect(api.addReplayBookmark).toHaveBeenCalled());
		expect(screen.getByRole("textbox", { name: "Bookmark note" })).toHaveValue("keep me");

		fireEvent.click(screen.getByRole("button", { name: "Remove the bookmark" }));
		expect(await screen.findByText("No bookmark yet.")).toBeInTheDocument();
	});
});

describe("ReplayBookmarks", () => {
	it("takes no bookmark while the session records, nor without a step", () => {
		const onGoTo = vi.fn();
		const mark = { id: "b1", step_index: 99, note: "gone", author: "", created_at: 1 };
		const { rerender } = render(
			<ReplayBookmarks
				session={session({ status: "recording", bookmarks: [mark] })}
				currentStep={null}
				onGoTo={onGoTo}
			/>,
		);
		expect(screen.getByText(/once the session has finished recording/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove the bookmark" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Step 99" }));
		expect(onGoTo).not.toHaveBeenCalled();

		rerender(<ReplayBookmarks session={session()} currentStep={null} onGoTo={onGoTo} />);
		expect(screen.getByRole("textbox", { name: "Bookmark note" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Bookmark step/ })).not.toBeInTheDocument();
	});
});
