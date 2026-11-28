/**
 * AI Pair Programming: the setup steps, then the running session (your work,
 * the coordination chat, the AI's work) driven by the real store, for the
 * project the page is opened for.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import {
	type AiAction,
	type PairSession,
	loadPairSession,
	usePairProgrammingStore,
} from "../../stores/pair-programming-store";
import { PairProgramming } from "../PairProgramming";

const SESSION: PairSession = {
	id: "pair_1",
	projectId: "p1",
	goal: "Add login",
	devScope: "The login form",
	aiScope: "The auth API",
	status: "active",
	messages: [],
	aiActions: [],
	createdAt: "2026-11-20T10:00:00.000Z",
	updatedAt: "2026-11-20T10:00:00.000Z",
};

const api = {
	startPairSession: vi.fn(),
	stopPairSession: vi.fn(),
	sendPairMessage: vi.fn(),
	createWorktreePR: vi.fn(),
	getPairSession: vi.fn(),
};

/** The main process keeps each project's session: here, the one the store holds. */
function storedSessionOf(projectId: string) {
	const session = usePairProgrammingStore.getState().session;
	return Promise.resolve({ success: true, data: session?.projectId === projectId ? session : null });
}

const scrollIntoView = vi.fn();

function running(patch: Partial<ReturnType<typeof usePairProgrammingStore.getState>> = {}) {
	usePairProgrammingStore.setState({ session: SESSION, status: "active", ...patch });
}

function action(id: string, actionType: AiAction["actionType"], extra: Partial<AiAction> = {}): AiAction {
	return {
		id,
		actionType,
		description: `${actionType} description`,
		timestamp: "2026-11-20T10:00:00.000Z",
		status: "completed",
		...extra,
	};
}

describe("PairProgramming", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		usePairProgrammingStore.getState().reset();
		for (const fn of Object.values(api)) fn.mockReset();
		api.getPairSession.mockImplementation(storedSessionOf);
		Object.assign(globalThis.electronAPI, api);
		// The page shows project p1.
		await loadPairSession("p1");
		scrollIntoView.mockReset();
		HTMLElement.prototype.scrollIntoView = scrollIntoView;
	});

	afterEach(() => {
		usePairProgrammingStore.getState().reset();
	});

	describe("setup", () => {
		it("starts a session for this project once the three scopes are filled", async () => {
			api.startPairSession.mockResolvedValue({ success: true, data: SESSION });
			render(<PairProgramming projectId="p1" />);

			expect(screen.getByRole("heading", { name: "AI Pair Programming" })).toBeInTheDocument();
			expect(screen.getByText("Parallel work on different file sets")).toBeInTheDocument();
			const start = screen.getByRole("button", { name: "Start Pair Programming" });
			expect(start).toBeDisabled();
			// The composer echoes the goal, or the hint while it is empty.
			expect(screen.getAllByText("e.g. Add user authentication with JWT tokens").length).toBeGreaterThan(0);

			await userEvent.type(screen.getByRole("textbox", { name: "Session Goal" }), "  Add login ");
			await userEvent.type(screen.getByRole("textbox", { name: "Your Scope (what you'll work on)" }), "Form");
			expect(start).toBeDisabled();
			await userEvent.type(screen.getByRole("textbox", { name: "AI Scope (what the AI will work on)" }), "API");
			expect(screen.queryByText("e.g. Add user authentication with JWT tokens", { selector: "span" })).toBeNull();

			await userEvent.click(start);

			expect(api.startPairSession).toHaveBeenCalledWith({
				projectId: "p1",
				goal: "Add login",
				devScope: "Form",
				aiScope: "API",
			});
			// The planning text the store writes is translated.
			expect(await screen.findByText("Analyzing the project and planning the AI's share of the work…")).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Add login" })).toBeInTheDocument();
		});

		it("says why a session could not start", async () => {
			api.startPairSession.mockResolvedValue({ success: false, error: "Project not found" });
			render(<PairProgramming projectId="p1" />);
			await fillAndStart();
			expect(await screen.findByText("Project not found")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "New Session" })).toBeInTheDocument();
		});

		it("falls back to a translated reason when the start gives none", async () => {
			api.startPairSession.mockResolvedValue({ success: false });
			render(<PairProgramming projectId="p1" />);
			await fillAndStart();
			expect(await screen.findByText("Failed to start pair programming session")).toBeInTheDocument();
		});

		it("does not leave the page planning forever when the start throws", async () => {
			api.startPairSession.mockRejectedValueOnce(new Error("IPC down")).mockRejectedValueOnce("no reason");
			const { unmount } = render(<PairProgramming projectId="p1" />);
			await fillAndStart();
			expect(await screen.findByText("IPC down")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Stop Session" })).toBeNull();
			unmount();

			usePairProgrammingStore.getState().reset();
			render(<PairProgramming projectId="p1" />);
			await fillAndStart();
			expect(await screen.findByText("Failed to start pair programming session")).toBeInTheDocument();
		});
	});

	describe("a running session", () => {
		it("shows both scopes, the status and the review-branch notice", () => {
			running({ statusMessage: "Writing the API" });
			render(<PairProgramming projectId="p1" />);

			expect(screen.getByRole("heading", { name: "Add login" })).toBeInTheDocument();
			expect(screen.getByText("Writing the API")).toBeInTheDocument();
			expect(screen.getByText("Working in parallel")).toBeInTheDocument();
			expect(screen.getByText("The login form")).toBeInTheDocument();
			expect(screen.getByText("The auth API")).toBeInTheDocument();
			expect(screen.getByText(/The AI works on a Kanban card's branch/)).toBeInTheDocument();
			expect(screen.getByRole("status")).toHaveTextContent("Working on your scope...");
			expect(screen.getByText("No messages yet. Send a message to coordinate with your AI partner.")).toBeInTheDocument();
			expect(screen.getByText("No actions yet")).toBeInTheDocument();
		});

		it("falls back to the title and subtitle when the session has no goal nor message", () => {
			running({ session: { ...SESSION, goal: "" }, status: "planning" });
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByRole("heading", { name: "AI Pair Programming" })).toBeInTheDocument();
			expect(screen.getByText("Real parallel coordinated development with AI")).toBeInTheDocument();
			expect(screen.getByRole("status")).toHaveTextContent("Analyzing project and planning implementation...");
		});

		it("sends a trimmed message with the button or Enter, and keeps Shift+Enter for a new line", async () => {
			running();
			render(<PairProgramming projectId="p1" />);
			const box = screen.getByRole("textbox", { name: "Message your AI partner..." });
			const send = screen.getByRole("button", { name: "Send" });
			expect(send).toBeDisabled();

			await userEvent.type(box, "  hello  ");
			await userEvent.click(send);
			expect(api.sendPairMessage).toHaveBeenCalledWith("p1", "pair_1", "hello");
			expect(box).toHaveValue("");
			expect(screen.getByText("hello")).toBeInTheDocument();
			expect(screen.getByText("hello").parentElement).toHaveTextContent("You");

			await userEvent.type(box, "line one{Shift>}{Enter}{/Shift}");
			expect(api.sendPairMessage).toHaveBeenCalledTimes(1);
			await userEvent.type(box, "{Enter}");
			expect(api.sendPairMessage).toHaveBeenLastCalledWith("p1", "pair_1", "line one");
		});

		it("does not send an empty message on Enter", async () => {
			running();
			render(<PairProgramming projectId="p1" />);
			await userEvent.type(screen.getByRole("textbox", { name: "Message your AI partner..." }), "   {Enter}");
			expect(api.sendPairMessage).not.toHaveBeenCalled();
		});

		it("does not send while the session is still being created", () => {
			usePairProgrammingStore.setState({ status: "planning", pendingMessage: "hi" });
			render(<PairProgramming projectId="p1" />);
			fireEvent.keyDown(screen.getByRole("textbox", { name: "Message your AI partner..." }), { key: "Enter" });
			expect(api.sendPairMessage).not.toHaveBeenCalled();
			// Stop has nothing to stop yet.
			fireEvent.click(screen.getByRole("button", { name: "Stop Session" }));
			expect(api.stopPairSession).not.toHaveBeenCalled();
		});

		it("labels the AI's messages and questions", () => {
			running({
				messages: [
					{ id: "m1", role: "ai", content: "Done with the routes", timestamp: "t" },
					{ id: "m2", role: "ai", content: "Which hash?", timestamp: "t", isQuestion: true },
				],
			});
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByText("Done with the routes")).toBeInTheDocument();
			expect(screen.getByText("Which hash?")).toBeInTheDocument();
			expect(screen.getByText("AI is asking")).toBeInTheDocument();
		});

		it("follows the chat and the AI stream as they grow", () => {
			running();
			render(<PairProgramming projectId="p1" />);
			expect(scrollIntoView).not.toHaveBeenCalled();

			act(() => usePairProgrammingStore.getState().addMessage({ id: "m1", role: "ai", content: "first", timestamp: "t" }));
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
			act(() => usePairProgrammingStore.getState().addMessage({ id: "m2", role: "ai", content: "second", timestamp: "t" }));
			expect(scrollIntoView).toHaveBeenCalledTimes(2);

			act(() => usePairProgrammingStore.getState().appendStreamContent("const a"));
			expect(scrollIntoView).toHaveBeenCalledTimes(3);
			act(() => usePairProgrammingStore.getState().appendStreamContent(" = 1;"));
			expect(scrollIntoView).toHaveBeenCalledTimes(4);
			expect(screen.getByText(/const a = 1;/)).toBeInTheDocument();
			expect(screen.getByText("▌")).toBeInTheDocument();
		});

		it("lists the AI's actions with their file or description", () => {
			running({
				aiActions: [
					action("a1", "file_created", { filePath: "src/auth.ts" }),
					action("a2", "file_modified", { filePath: "src/app.ts" }),
					action("a3", "command_run"),
					action("a4", "thinking"),
				],
			});
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByText("Created")).toBeInTheDocument();
			expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
			expect(screen.getByText("Modified")).toBeInTheDocument();
			expect(screen.getByText("Ran")).toBeInTheDocument();
			expect(screen.getByText("command_run description")).toBeInTheDocument();
			expect(screen.getByText("Thinking")).toBeInTheDocument();
			// A file action shows its path, not its description.
			expect(screen.queryByText("file_created description")).toBeNull();
		});

		it("warns about files both sides touched", () => {
			running({
				conflicts: [
					{ id: "c1", filePath: "src/a.ts", message: "x", timestamp: "t" },
					{ id: "c2", filePath: "src/b.ts", message: "y", timestamp: "t" },
				],
			});
			render(<PairProgramming projectId="p1" />);
			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent("The AI may have touched files in your scope. Please review.");
			expect(alert).toHaveTextContent("src/a.ts, src/b.ts");
		});

		it("stops the session and marks it complete", async () => {
			api.stopPairSession.mockResolvedValue({ success: true });
			running();
			render(<PairProgramming projectId="p1" />);
			await userEvent.click(screen.getByRole("button", { name: "Stop Session" }));
			expect(api.stopPairSession).toHaveBeenCalledWith("p1", "pair_1");
			expect(await screen.findByText("Session stopped.")).toBeInTheDocument();
			expect(screen.getByText("Session complete")).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Stop Session" })).toBeNull();
			expect(screen.getByRole("textbox", { name: "Message your AI partner..." })).toBeDisabled();
		});

		it("says why a stop failed instead of pretending it worked", async () => {
			api.stopPairSession
				.mockResolvedValueOnce({ success: false, error: "No active session" })
				.mockResolvedValueOnce({ success: false })
				.mockRejectedValueOnce(new Error("IPC down"))
				.mockRejectedValueOnce(null);
			running();
			render(<PairProgramming projectId="p1" />);

			for (const reason of [
				"No active session",
				"Failed to stop the pair programming session",
				"IPC down",
				"Failed to stop the pair programming session",
			]) {
				act(() => usePairProgrammingStore.setState({ status: "active", statusMessage: "" }));
				await userEvent.click(screen.getByRole("button", { name: "Stop Session" }));
				expect(await screen.findByText(reason)).toBeInTheDocument();
				expect(screen.getByText("Error")).toBeInTheDocument();
			}
		});

		it("shows where the AI's work was committed once the review card exists", async () => {
			running({ status: "completed" });
			usePairProgrammingStore.getState().setReview({
				taskId: "task-9",
				title: "Pair: Add login",
				branch: "workpilot/task-9",
				baseBranch: "develop",
				files: ["src/auth.ts"],
			});
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByText("Written on a review branch, not in your project folder")).toBeInTheDocument();
			expect(screen.queryByText(/The AI works on a Kanban card's branch/)).toBeNull();
			expect(screen.queryByRole("status")).not.toHaveTextContent("Working on your scope...");
		});

		it("starts over from a finished session", async () => {
			running({ status: "error", statusMessage: "Runner crashed" });
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByText("Runner crashed")).toBeInTheDocument();
			await userEvent.click(screen.getByRole("button", { name: "New Session" }));
			expect(screen.getByRole("button", { name: "Start Pair Programming" })).toBeInTheDocument();
		});

		it("keeps a loaded session that has not started yet on its page", () => {
			running({ status: "idle", session: { ...SESSION, goal: "Paused work" } });
			render(<PairProgramming projectId="p1" />);
			expect(screen.getByRole("heading", { name: "Paused work" })).toBeInTheDocument();
			expect(screen.getByText("Ready to pair")).toBeInTheDocument();
		});

		it("loads the session of the project on screen, and none of the last project's", async () => {
			api.getPairSession.mockImplementation(async (projectId: string) => ({
				success: true,
				data: projectId === "p1" ? { ...SESSION, goal: "Refactor the parser" } : null,
			}));
			const { rerender } = render(<PairProgramming projectId="p1" />);
			expect(await screen.findByRole("heading", { name: "Refactor the parser" })).toBeInTheDocument();
			expect(api.getPairSession).toHaveBeenCalledWith("p1");

			rerender(<PairProgramming projectId="p2" />);
			await waitFor(() => expect(screen.queryByText("Refactor the parser")).toBeNull());
			expect(api.getPairSession).toHaveBeenLastCalledWith("p2");
			expect(screen.getByText("Session Goal")).toBeInTheDocument();
		});

		it("does not show another project's session on this project's page", async () => {
			running();
			const { rerender } = render(<PairProgramming projectId="p1" />);
			expect(screen.getByRole("heading", { name: "Add login" })).toBeInTheDocument();

			rerender(<PairProgramming projectId="p2" />);
			expect(screen.queryByRole("heading", { name: "Add login" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Stop Session" })).toBeNull();
			expect(screen.getByRole("button", { name: "Start Pair Programming" })).toBeInTheDocument();
		});
	});

	it("shows nothing in the side columns before the session exists", () => {
		usePairProgrammingStore.setState({ status: "planning" });
		render(<PairProgramming projectId="p1" />);
		expect(screen.queryByText("Your scope")).toBeNull();
		expect(screen.queryByText(/The AI works on a Kanban card's branch/)).toBeNull();
	});
});

async function fillAndStart() {
	await userEvent.type(screen.getByRole("textbox", { name: "Session Goal" }), "Goal");
	await userEvent.type(screen.getByRole("textbox", { name: "Your Scope (what you'll work on)" }), "Mine");
	await userEvent.type(screen.getByRole("textbox", { name: "AI Scope (what the AI will work on)" }), "Its");
	await userEvent.click(screen.getByRole("button", { name: "Start Pair Programming" }));
	await waitFor(() => expect(api.startPairSession).toHaveBeenCalled());
}
