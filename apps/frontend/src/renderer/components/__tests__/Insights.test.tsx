/**
 * The Insights chat: sessions, the conversation and its streamed answer, the
 * tasks it suggests, and the composer.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	InsightsChatMessage,
	InsightsSession,
} from "../../../shared/types";
import { useInsightsStore } from "../../stores/insights-store";
import { Insights } from "../Insights";

const mocks = vi.hoisted(() => ({
	loadInsightsSession: vi.fn(),
	sendMessage: vi.fn(),
	newSession: vi.fn(),
	switchSession: vi.fn(),
	deleteSession: vi.fn(),
	renameSession: vi.fn(),
	createTaskFromSuggestion: vi.fn(),
	updateModelConfig: vi.fn(),
	loadTasks: vi.fn(),
	useServerViewLive: vi.fn(),
	seen: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("../../stores/insights-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../stores/insights-store")>()),
	loadInsightsSession: mocks.loadInsightsSession,
	sendMessage: mocks.sendMessage,
	newSession: mocks.newSession,
	switchSession: mocks.switchSession,
	deleteSession: mocks.deleteSession,
	renameSession: mocks.renameSession,
	createTaskFromSuggestion: mocks.createTaskFromSuggestion,
	updateModelConfig: mocks.updateModelConfig,
}));
vi.mock("../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../stores/task-store")>()),
	loadTasks: mocks.loadTasks,
}));
vi.mock("../../hooks/useServerViewLive", () => ({
	useServerViewLive: mocks.useServerViewLive,
}));
vi.mock("../ChatHistorySidebar", () => ({
	ChatHistorySidebar: (props: Record<string, unknown>) => {
		mocks.seen.sidebar = props;
		return <aside data-testid="history" />;
	},
}));
vi.mock("../InsightsModelSelector", () => ({
	InsightsModelSelector: (props: Record<string, unknown>) => {
		mocks.seen.model = props;
		return null;
	},
}));
vi.mock("../LearningModeToggle", () => ({
	LearningModeToggle: (props: Record<string, unknown>) => {
		mocks.seen.learning = props;
		return null;
	},
}));
vi.mock("../LearningExplanationCard", () => ({
	LearningExplanationCard: ({ explanation }: { explanation: { title: string } }) => (
		<div data-testid="explanation">{explanation.title}</div>
	),
}));

const message = (over: Partial<InsightsChatMessage>): InsightsChatMessage => ({
	id: "m1",
	role: "user",
	content: "How is auth done?",
	timestamp: new Date(0),
	...over,
});

const SUGGESTED = message({
	id: "m2",
	role: "assistant",
	content: "Add a **login** page. See [docs](https://example.com/docs), [home](/home), [bad](javascript:alert(1)).",
	suggestedTask: {
		title: "Add login page",
		description: "A page to sign in",
		metadata: { category: "security", complexity: "small" } as never,
	},
	toolsUsed: [
		{ name: "Read", input: "src/auth.ts", timestamp: new Date(1) },
		{ name: "Read", input: "src/user.ts", timestamp: new Date(2) },
		{ name: "Glob", timestamp: new Date(3) },
		{ name: "Grep", input: "token", timestamp: new Date(4) },
		{ name: "Bash", timestamp: new Date(5) },
	],
});

const session = (over: Partial<InsightsSession> = {}): InsightsSession => ({
	id: "s1",
	projectId: "p1",
	messages: [message({}), SUGGESTED],
	createdAt: new Date(0),
	updatedAt: new Date(0),
	...over,
});

function setStore(state: Partial<ReturnType<typeof useInsightsStore.getState>>) {
	act(() => useInsightsStore.setState(state));
}

describe("Insights", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		for (const key of Object.keys(mocks.seen)) delete mocks.seen[key];
		useInsightsStore.setState({
			session: null,
			sessions: [],
			status: { phase: "idle" },
			streamingContent: "",
			currentTool: null,
			isLoadingSessions: false,
			currentExplanation: null,
			learningModeEnabled: false,
		});
	});

	it("loads the project's session and suggests first questions", async () => {
		render(<Insights projectId="p1" />);

		expect(mocks.loadInsightsSession).toHaveBeenCalledWith("p1");
		expect(mocks.useServerViewLive).toHaveBeenCalledWith("p1", "insights");
		expect(screen.getByText("Start a Conversation")).toBeInTheDocument();
		const input = screen.getByRole("textbox", { name: "Ask about your codebase..." });
		expect(input).toHaveFocus();

		await userEvent.click(screen.getByRole("button", { name: "Are there any security concerns?" }));
		expect(input).toHaveValue("Are there any security concerns?");
		expect(input).toHaveFocus();
	});

	it("sends a message with Enter, keeps Shift+Enter for a new line", async () => {
		render(<Insights projectId="p1" />);
		const input = screen.getByRole("textbox", { name: "Ask about your codebase..." });
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toBeDisabled();

		await userEvent.type(input, "  first{Shift>}{Enter}{/Shift}line");
		expect(mocks.sendMessage).not.toHaveBeenCalled();
		await userEvent.type(input, "{Enter}");

		expect(mocks.sendMessage).toHaveBeenCalledWith("p1", "first\nline");
		expect(input).toHaveValue("");

		await userEvent.type(input, "second");
		await userEvent.click(send);
		expect(mocks.sendMessage).toHaveBeenLastCalledWith("p1", "second");

		// Blank text sends nothing.
		await userEvent.type(input, "   {Enter}");
		expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("shows the conversation with safe links and the tools used", async () => {
		setStore({ session: session() });
		render(<Insights projectId="p1" />);

		expect(screen.getByText("You")).toBeInTheDocument();
		expect(screen.getByText("How is auth done?")).toBeInTheDocument();
		expect(screen.getByText("login").tagName).toBe("STRONG");
		const external = screen.getByRole("link", { name: /docs/ });
		expect(external).toHaveAttribute("target", "_blank");
		expect(external).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.getByRole("link", { name: "home" })).not.toHaveAttribute("target");
		// A javascript: link is shown as text only.
		expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
		expect(screen.getByText("bad")).toBeInTheDocument();

		const toolsButton = screen.getByRole("button", { name: /5 tools used/ });
		await userEvent.click(toolsButton);
		expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
		expect(screen.getByText("src/user.ts")).toBeInTheDocument();
		expect(screen.getByText("Bash")).toBeInTheDocument();
		await userEvent.click(toolsButton);
		expect(screen.queryByText("src/auth.ts")).not.toBeInTheDocument();
	});

	it("says one tool in the singular", () => {
		setStore({
			session: session({
				messages: [
					message({
						role: "assistant",
						toolsUsed: [{ name: "Read", timestamp: new Date(0) }],
					}),
				],
			}),
		});
		render(<Insights projectId="p1" />);
		expect(screen.getByRole("button", { name: /1 tool used/ })).toBeInTheDocument();
	});

	it("creates the suggested task and reloads the board", async () => {
		let resolve!: (task: unknown) => void;
		mocks.createTaskFromSuggestion.mockReturnValue(new Promise((r) => (resolve = r)));
		setStore({ session: session() });
		render(<Insights projectId="p1" />);

		expect(screen.getByText("Add login page")).toBeInTheDocument();
		expect(screen.getByText("Security")).toBeInTheDocument();
		expect(screen.getByText("Small")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(mocks.createTaskFromSuggestion).toHaveBeenCalledWith(
			"p1",
			"Add login page",
			"A page to sign in",
			{ category: "security", complexity: "small" },
		);
		expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();

		await act(async () => resolve({ id: "t1" }));
		expect(screen.getByRole("button", { name: "Task Created" })).toBeDisabled();
		expect(mocks.loadTasks).toHaveBeenCalledWith("p1");
	});

	it.each([
		["refused", () => mocks.createTaskFromSuggestion.mockResolvedValue(null)],
		["failing", () => mocks.createTaskFromSuggestion.mockRejectedValue(new Error("ipc"))],
	])("says when the suggested task could not be created (%s)", async (_l, arrange) => {
		arrange();
		setStore({ session: session() });
		render(<Insights projectId="p1" />);

		await userEvent.click(screen.getByRole("button", { name: "Create Task" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The task could not be created. Try again.",
		);
		expect(screen.getByRole("button", { name: "Create Task" })).toBeEnabled();
		expect(mocks.loadTasks).not.toHaveBeenCalled();
	});

	it("shows an unknown category as it came, and no badge without metadata", () => {
		setStore({
			session: session({
				messages: [
					message({
						id: "a",
						role: "assistant",
						suggestedTask: {
							title: "Odd",
							description: "d",
							metadata: { category: "chores" } as never,
						},
					}),
					message({
						id: "b",
						role: "assistant",
						suggestedTask: { title: "Bare", description: "d" },
					}),
				],
			}),
		});
		render(<Insights projectId="p1" />);
		expect(screen.getByText("chores")).toBeInTheDocument();
		expect(screen.getByText("Bare")).toBeInTheDocument();
	});

	it("shows the streamed answer, the tool at work and the explanation", () => {
		setStore({
			session: session({ messages: [] }),
			status: { phase: "streaming" },
			streamingContent: "Partial *answer*",
			currentTool: { name: "Grep", input: "token" },
			currentExplanation: { title: "Why grep" } as never,
			learningModeEnabled: true,
		});
		render(<Insights projectId="p1" />);

		expect(screen.getByText("answer").tagName).toBe("EM");
		expect(screen.getByText("Searching code")).toBeInTheDocument();
		expect(screen.getByText("token")).toBeInTheDocument();
		expect(screen.getByTestId("explanation")).toHaveTextContent("Why grep");
		expect(screen.getByRole("textbox", { name: "Ask about your codebase..." })).toBeDisabled();
		expect(mocks.seen.model).toMatchObject({ disabled: true });
	});

	it.each([
		["Read", "Reading file"],
		["Glob", "Searching files"],
		["WebFetch", "WebFetch"],
	])("names the %s tool at work", (name, label) => {
		setStore({ session: session(), currentTool: { name } });
		render(<Insights projectId="p1" />);
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("hides the explanation outside learning mode, and shows thinking", () => {
		setStore({
			session: session(),
			status: { phase: "thinking" },
			currentExplanation: { title: "Why" } as never,
		});
		render(<Insights projectId="p1" />);
		expect(screen.queryByTestId("explanation")).not.toBeInTheDocument();
		expect(screen.getByText("Thinking...")).toBeInTheDocument();
	});

	it("shows an error", () => {
		setStore({ session: session(), status: { phase: "error", error: "Backend down" } });
		render(<Insights projectId="p1" />);
		expect(screen.getByRole("alert")).toHaveTextContent("Backend down");
	});

	it("reads a teammate's conversation without writing to it", () => {
		setStore({ session: session({ readOnly: true, ownerName: "Sam" } as never) });
		render(<Insights projectId="p1" />);
		const input = screen.getByRole("textbox", { name: "Ask about your codebase..." });
		expect(input).toBeDisabled();
		expect(input).toHaveAttribute(
			"placeholder",
			"This conversation is Sam's: start a new one to ask your own questions",
		);
	});

	it("names an unknown owner with a question mark", () => {
		setStore({ session: session({ readOnly: true } as never) });
		render(<Insights projectId="p1" />);
		expect(screen.getByRole("textbox", { name: "Ask about your codebase..." })).toHaveAttribute(
			"placeholder",
			"This conversation is ?'s: start a new one to ask your own questions",
		);
	});

	it("manages the sessions through the history", async () => {
		mocks.deleteSession.mockResolvedValue(true);
		mocks.renameSession.mockResolvedValue(true);
		setStore({ session: session(), sessions: [{ id: "s1" }, { id: "s2" }] as never });
		render(<Insights projectId="p1" />);
		const sidebar = mocks.seen.sidebar as {
			currentSessionId: string | null;
			onSelectSession: (id: string) => Promise<void>;
			onDeleteSession: (id: string) => Promise<boolean>;
			onRenameSession: (id: string, title: string) => Promise<boolean>;
			onNewSession: () => Promise<void>;
		};
		expect(sidebar.currentSessionId).toBe("s1");

		await act(() => sidebar.onSelectSession("s1"));
		expect(mocks.switchSession).not.toHaveBeenCalled();
		await act(() => sidebar.onSelectSession("s2"));
		expect(mocks.switchSession).toHaveBeenCalledWith("p1", "s2");
		await expect(sidebar.onDeleteSession("s2")).resolves.toBe(true);
		expect(mocks.deleteSession).toHaveBeenCalledWith("p1", "s2");
		await expect(sidebar.onRenameSession("s1", "Auth")).resolves.toBe(true);
		expect(mocks.renameSession).toHaveBeenCalledWith("p1", "s1", "Auth");
		await act(() => sidebar.onNewSession());
		expect(mocks.newSession).toHaveBeenCalledWith("p1");
	});

	it("starts a new chat from the header and hides the history", async () => {
		render(<Insights projectId="p1" />);
		expect(mocks.seen.sidebar).toMatchObject({ currentSessionId: null });

		await userEvent.click(screen.getByRole("button", { name: "New Chat" }));
		expect(mocks.newSession).toHaveBeenCalledWith("p1");

		await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
		expect(screen.queryByTestId("history")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
		expect(screen.getByTestId("history")).toBeInTheDocument();
	});

	it("saves the model of a session, and turns learning mode on", async () => {
		const setLearningModeEnabled = vi.fn();
		setStore({ setLearningModeEnabled });
		const { rerender } = render(<Insights projectId="p1" />);
		const config = { profileId: "x", model: "m" };

		await act(() => (mocks.seen.model.onConfigChange as (c: unknown) => Promise<void>)(config));
		expect(mocks.updateModelConfig).not.toHaveBeenCalled();

		setStore({ session: session() });
		rerender(<Insights projectId="p1" />);
		await act(() => (mocks.seen.model.onConfigChange as (c: unknown) => Promise<void>)(config));
		expect(mocks.updateModelConfig).toHaveBeenCalledWith("p1", "s1", config);

		await act(() =>
			(mocks.seen.learning.onConfigChange as (c: unknown) => Promise<void>)({ enabled: true }),
		);
		expect(setLearningModeEnabled).toHaveBeenCalledWith(true);
	});

	describe("auto-scroll", () => {
		function viewport(): HTMLElement {
			const el = document.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement;
			Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
			Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
			return el;
		}

		it("follows the answer at the bottom, and not after the user scrolled up", async () => {
			setStore({ session: session() });
			render(<Insights projectId="p1" />);
			const el = viewport();

			setStore({ streamingContent: "a" });
			expect(el.scrollTop).toBe(1000);

			el.scrollTop = 100;
			fireEvent.scroll(el);
			setStore({ streamingContent: "ab" });
			expect(el.scrollTop).toBe(100);

			// Sending resumes following.
			await userEvent.type(
				screen.getByRole("textbox", { name: "Ask about your codebase..." }),
				"next{Enter}",
			);
			await waitFor(() => expect(el.scrollTop).toBe(1000));
		});
	});
});
