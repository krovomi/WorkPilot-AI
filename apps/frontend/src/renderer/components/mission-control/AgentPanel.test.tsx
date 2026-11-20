/**
 * One agent's card: who it is, what it runs on, what it is doing, and the
 * controls its status allows. Status and role read in the app's language.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { AgentSlot } from "../../stores/mission-control-store";
import { AgentPanel } from "./AgentPanel";

function agent(overrides: Partial<AgentSlot> = {}): AgentSlot {
	return {
		id: "a1",
		name: "Agent Coder",
		role: "coder",
		status: "idle",
		provider: "anthropic",
		model: "claude-sonnet",
		model_label: "Sonnet",
		current_task: "",
		current_step: "",
		progress: 0,
		tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 12345, estimated_cost_usd: 0.01234 },
		active_files: [],
		current_thinking: "",
		last_tool_call: "",
		last_tool_input: "",
		decision_path: [],
		started_at: null,
		completed_at: null,
		elapsed_seconds: 65,
		streaming_session_id: null,
		output: "",
		error_message: "",
		...overrides,
	};
}

const handlers = {
	onSelect: vi.fn(),
	onStart: vi.fn(),
	onStop: vi.fn(),
	onRemove: vi.fn(),
	onShowDecisionTree: vi.fn(),
};

function panel(overrides: Partial<AgentSlot> = {}, isSelected = false) {
	return render(<AgentPanel agent={agent(overrides)} isSelected={isSelected} {...handlers} />);
}

beforeEach(async () => {
	vi.clearAllMocks();
	await i18n.changeLanguage("en");
});

describe("AgentPanel", () => {
	it("names the agent, its role, provider, model and usage in words", () => {
		panel();
		expect(screen.getByRole("button", { name: "Agent Coder" })).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByText("Idle")).toBeInTheDocument();
		expect(screen.queryByText("idle")).toBeNull();
		expect(screen.getByText("💻 Coder")).toBeInTheDocument();
		expect(screen.getByText("Anthropic (Claude): Sonnet")).toBeInTheDocument();
		expect(screen.getByTitle("Tokens")).toHaveTextContent("12,345");
		// One dollar sign: the icon is not followed by a second one.
		expect(screen.getByTitle("Cost")).toHaveTextContent(/^\$0\.0123$/);
		expect(screen.getByTitle("Elapsed")).toHaveTextContent("1m 5s");
	});

	it("writes tokens and elapsed time the way the app's language does", async () => {
		await i18n.changeLanguage("fr");
		panel({ elapsed_seconds: 42 });
		expect(screen.getByTitle("Tokens")).toHaveTextContent(/^12\s345$/);
		expect(screen.getByText("Inactif")).toBeInTheDocument();
		expect(screen.getByTitle("Coût")).toHaveTextContent("0.0123 $");
		expect(screen.getByTitle("Écoulé")).toHaveTextContent("42s");
	});

	it("is selected from its name, a real button", async () => {
		const user = userEvent.setup();
		panel({}, true);
		const name = screen.getByRole("button", { name: "Agent Coder" });
		expect(name).toHaveAttribute("aria-pressed", "true");
		await user.click(name);
		expect(handlers.onSelect).toHaveBeenCalledTimes(1);
	});

	it("opens its decision tree or removes it from its menu", async () => {
		const user = userEvent.setup();
		panel();
		await user.click(screen.getByRole("button", { name: "Actions for Agent Coder" }));
		await user.click(screen.getByRole("menuitem", { name: "Decision Tree" }));
		expect(handlers.onShowDecisionTree).toHaveBeenCalledTimes(1);
		expect(handlers.onSelect).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Actions for Agent Coder" }));
		await user.click(screen.getByRole("menuitem", { name: "Remove" }));
		expect(handlers.onRemove).toHaveBeenCalledTimes(1);
	});

	it("starts an idle agent on the typed task, by Enter or by the button, once", async () => {
		const user = userEvent.setup();
		panel();
		const input = screen.getByRole("textbox", { name: "Task for Agent Coder" });
		const start = screen.getByRole("button", { name: "Start" });
		expect(input).toHaveAttribute("placeholder", "Task description...");
		expect(start).toBeDisabled();

		await user.type(input, "   {Enter}");
		expect(handlers.onStart).not.toHaveBeenCalled();

		await user.clear(input);
		await user.type(input, "Fix the login{Enter}");
		expect(handlers.onStart).toHaveBeenCalledWith("Fix the login");
		expect(input).toHaveValue("");

		await user.type(input, "Write the tests");
		expect(start).toBeEnabled();
		await user.click(start);
		expect(handlers.onStart).toHaveBeenLastCalledWith("Write the tests");
		expect(handlers.onStart).toHaveBeenCalledTimes(2);
		expect(input).toHaveValue("");
		expect(handlers.onSelect).not.toHaveBeenCalled();
	});

	it("shows a running agent waiting on its model, its thinking and its last tool", async () => {
		const user = userEvent.setup();
		panel({
			status: "running",
			current_task: "Fix the login",
			current_thinking: "The session cookie expires too early",
			last_tool_call: "Read",
			last_tool_input: "src/auth.ts",
		});
		expect(screen.getByText("Running")).toBeInTheDocument();
		expect(screen.getByText("Fix the login")).toBeInTheDocument();
		expect(screen.getByText("Waiting for the model…")).toBeInTheDocument();
		expect(screen.getByText("Thinking")).toBeInTheDocument();
		expect(screen.getByText("The session cookie expires too early")).toBeInTheDocument();
		expect(screen.getByText("Read")).toBeInTheDocument();
		expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Stop Agent Coder" }));
		expect(handlers.onStop).toHaveBeenCalledTimes(1);
	});

	it("shows the answer as it streams in", () => {
		panel({ status: "running", output: "The cookie lifetime is now 30 days.", last_tool_call: "Edit" });
		expect(screen.getByText("Answering…")).toBeInTheDocument();
		expect(screen.getByText("Answer")).toBeInTheDocument();
		expect(screen.getByTestId("mission-control-agent-output")).toHaveTextContent(
			"The cookie lifetime is now 30 days.",
		);
		expect(screen.getByText("Edit")).toBeInTheDocument();
		expect(screen.queryByText("Thinking")).toBeNull();
	});

	it("keeps the answer but hides thinking and tools once the run is over", () => {
		panel({
			status: "completed",
			output: "Done.",
			current_thinking: "Old thought",
			last_tool_call: "Bash",
			elapsed_seconds: 3725,
		});
		expect(screen.getByText("Completed")).toBeInTheDocument();
		expect(screen.getByText("Done.")).toBeInTheDocument();
		expect(screen.queryByText("Old thought")).toBeNull();
		expect(screen.queryByText("Bash")).toBeNull();
		expect(screen.queryByTestId("mission-control-agent-running")).toBeNull();
		expect(screen.getByTitle("Elapsed")).toHaveTextContent("1h 2m");
	});

	it("restarts a finished or failed agent on its last task, and shows the failure", async () => {
		const user = userEvent.setup();
		panel({ status: "error", error_message: "Rate limited by the provider" });
		expect(screen.getByText("Error")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Rate limited by the provider");
		await user.click(screen.getByRole("button", { name: "Restart" }));
		expect(handlers.onStart).toHaveBeenCalledWith("");
	});

	it("can stop a paused agent and offers nothing to a waiting one", () => {
		const { unmount } = panel({ status: "paused" });
		expect(screen.getByText("Paused")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stop Agent Coder" })).toBeInTheDocument();
		unmount();

		panel({ status: "waiting" });
		expect(screen.getByText("Waiting")).toBeInTheDocument();
		for (const name of ["Stop Agent Coder", "Restart", "Start"]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("names the model by its id, or says there is none, and keeps an unknown provider's name", () => {
		const { unmount } = panel({ provider: "acme", model_label: "", model: "acme-large" });
		expect(screen.getByText("acme: acme-large")).toBeInTheDocument();
		unmount();

		panel({ provider: "", model_label: "", model: "" });
		expect(screen.getByText("No model")).toHaveTextContent(/^No model$/);
	});

	it("lists the last three files it touched by name, on any OS, and counts the rest", () => {
		panel({
			active_files: ["a/one.ts", "a/two.ts", "src/auth/login.ts", "C:\\repo\\src\\session.ts", "docs/readme.md"],
		});
		expect(screen.getByText("Files (5)")).toBeInTheDocument();
		const files = screen.getByText("Files (5)").parentElement as HTMLElement;
		expect(within(files).getByText("login.ts")).toBeInTheDocument();
		expect(within(files).getByText("session.ts")).toBeInTheDocument();
		expect(within(files).getByText("readme.md")).toBeInTheDocument();
		expect(within(files).queryByText("one.ts")).toBeNull();
		expect(within(files).getByText("+2")).toBeInTheDocument();
	});

	it("shows up to three files without a remainder", () => {
		panel({ active_files: ["src/a.ts"] });
		expect(screen.getByText("Files (1)")).toBeInTheDocument();
		expect(screen.getByText("a.ts")).toBeInTheDocument();
		expect(screen.queryByText(/^\+/)).toBeNull();
	});
});
