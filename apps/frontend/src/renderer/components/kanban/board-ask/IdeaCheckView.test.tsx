/**
 * « Vérifier une idée »: the tab sends the idea to the main process, shows
 * each requirement with its verdict and tickets, and creates a card with only
 * what is left; it says when no model judged, when it failed, and when
 * everything is already done.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import type { BoardIdeaResult, Task } from "../../../../shared/types";
import { useBoardAskStore } from "../../../stores/board-ask-store";
import { useTaskStore } from "../../../stores/task-store";
import { BoardAskButton } from "./BoardAskButton";

const judged: BoardIdeaResult = {
	title: "Admin user export",
	summary: "The export exists; the email is missing.",
	requirements: [
		{
			text: "Export users to CSV",
			verdict: "done",
			reason: "Shipped",
			matches: [{ taskId: "t1", title: "Export CSV", state: "done" }],
		},
		{ text: "Email when ready", verdict: "missing", matches: [] },
	],
	mode: "ai",
	searched: 7,
};

let api: RendererApi;
let checkBoardIdea: ReturnType<typeof vi.fn>;
let createTaskApi: ReturnType<typeof vi.fn>;

async function openIdeaTab(onOpenTask = vi.fn()) {
	useBoardAskStore.setState({ open: true });
	render(<BoardAskButton projectId="p1" onOpenTask={onOpenTask} />);
	await userEvent.click(screen.getByRole("tab", { name: "Check an idea" }));
	return screen.getByRole("textbox", { name: "The feature to check" });
}

beforeEach(() => {
	checkBoardIdea = vi.fn(async () => ({ success: true, data: judged }));
	createTaskApi = vi.fn(async (_projectId: string, title: string) => ({
		success: true,
		data: { id: "new", title } as Task,
	}));
	api = installRendererApi({ checkBoardIdea, createTask: createTaskApi });
	useBoardAskStore.setState({ open: false, tab: "ask", conversations: {}, ideas: {} });
	useTaskStore.setState({ tasks: [{ id: "t1", title: "Export CSV" } as Task] });
});
afterEach(() => api.restore());

describe("IdeaCheckView", () => {
	it("checks an idea, shows each requirement's verdict, and creates a card with what is missing", async () => {
		const onOpenTask = vi.fn();
		const box = await openIdeaTab(onOpenTask);
		expect(screen.getByText(/splits the idea into requirements/)).toBeInTheDocument();
		await userEvent.type(box, "Admins export users to CSV and get an email");
		await userEvent.click(screen.getByRole("button", { name: "Check" }));

		expect(await screen.findByText("Admin user export")).toBeInTheDocument();
		expect(checkBoardIdea).toHaveBeenCalledWith({ projectId: "p1", idea: "Admins export users to CSV and get an email" });
		expect(screen.getByText("The export exists; the email is missing.")).toBeInTheDocument();
		expect(screen.getByText("1 done")).toBeInTheDocument();
		expect(screen.getByText("1 missing")).toBeInTheDocument();
		expect(screen.getByText("Already done")).toBeInTheDocument();
		expect(screen.getByText("Missing")).toBeInTheDocument();
		expect(screen.getByText("Shipped")).toBeInTheDocument();
		expect(screen.queryByText(/No model judged/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Create a card with what is missing" }));
		expect(await screen.findByText("Card created in the backlog.")).toBeInTheDocument();
		const [projectId, title, description] = createTaskApi.mock.calls[0] as [string, string, string];
		expect([projectId, title]).toEqual(["p1", "Admin user export"]);
		expect(description).toContain("## To build\n\n- Email when ready");
		expect(description).toContain("## Already done\n\n- Export users to CSV → Export CSV");
		expect(useBoardAskStore.getState().ideas.p1?.createdTaskId).toBe("new");

		await userEvent.click(screen.getByRole("button", { name: "Open the card" }));
		expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
		expect(useBoardAskStore.getState().open).toBe(false);
	});

	it("opens a ticket of a requirement, and checks another idea from scratch", async () => {
		const onOpenTask = vi.fn();
		const box = await openIdeaTab(onOpenTask);
		await userEvent.type(box, "Export users{Control>}{Enter}{/Control}");
		await userEvent.click(await screen.findByRole("button", { name: /Export CSV/ }));
		expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));

		useBoardAskStore.setState({ open: true });
		await userEvent.click(await screen.findByRole("button", { name: "Check another idea" }));
		expect(useBoardAskStore.getState().ideas.p1).toBeUndefined();
		expect(screen.getByRole("textbox", { name: "The feature to check" })).toHaveValue("");
	});

	it("says when no model judged, when nothing is left, and when the card cannot be created", async () => {
		checkBoardIdea.mockResolvedValueOnce({
			success: true,
			data: {
				title: "",
				summary: "",
				requirements: [{ text: "Export users", verdict: "unknown", matches: [] }],
				mode: "keywords",
				searched: 3,
			},
		});
		createTaskApi.mockResolvedValueOnce({ success: false, error: "disk full" });
		const box = await openIdeaTab();
		await userEvent.type(box, "Export users{Control>}{Enter}{/Control}");
		expect(await screen.findByText(/No model judged these requirements/)).toBeInTheDocument();
		expect(screen.getByText("To check")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Create a card with what is missing" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The card could not be created.");
		expect(createTaskApi.mock.calls[0]?.[1]).toBe("Export users");

		checkBoardIdea.mockResolvedValueOnce({
			success: true,
			data: { ...judged, requirements: [judged.requirements[0]] },
		});
		await userEvent.click(screen.getByRole("button", { name: "Check" }));
		expect(await screen.findByText(/Every requirement is already done/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create a card with what is missing" })).not.toBeInTheDocument();

		checkBoardIdea.mockResolvedValueOnce({ success: true, data: { ...judged, requirements: [] } });
		await userEvent.click(screen.getByRole("button", { name: "Check" }));
		expect(await screen.findByText("No requirement could be read from this idea.")).toBeInTheDocument();
	});

	it("says when a server board or the check failed, and checks nothing empty", async () => {
		checkBoardIdea
			.mockResolvedValueOnce({ success: false, error: "server_unreachable" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("ipc down"))
			.mockRejectedValueOnce("ipc gone");
		const box = await openIdeaTab();
		await userEvent.type(box, "   {Control>}{Enter}{/Control}");
		expect(checkBoardIdea).not.toHaveBeenCalled();
		await userEvent.type(box, "Export");
		const check = screen.getByRole("button", { name: "Check" });
		await userEvent.click(check);
		expect(await screen.findByText(/server/i)).toBeInTheDocument();
		await userEvent.click(check);
		expect(await screen.findByText("The idea could not be checked. Try again.")).toBeInTheDocument();
		await userEvent.click(check);
		await waitFor(() => expect(useBoardAskStore.getState().ideas.p1?.error).toBe("ipc down"));
		// Enter alone writes a new line; Cmd + Enter checks, as Ctrl + Enter does.
		await userEvent.type(box, "{Enter}");
		expect(checkBoardIdea).toHaveBeenCalledTimes(3);
		await userEvent.type(box, "{Meta>}{Enter}{/Meta}");
		await waitFor(() => expect(useBoardAskStore.getState().ideas.p1?.error).toBe("ipc gone"));
	});

	it("shows the check while it runs, and drops an answer for an idea cleared meanwhile", async () => {
		let answer: (value: unknown) => void = () => undefined;
		checkBoardIdea.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		const box = await openIdeaTab();
		await userEvent.type(box, "Export");
		await userEvent.click(screen.getByRole("button", { name: "Check" }));
		expect(await screen.findByText("Reading the board for each requirement…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();

		// A second check of the same project waits for the first.
		await act(() => useBoardAskStore.getState().checkIdea("p1", "Other"));
		expect(checkBoardIdea).toHaveBeenCalledTimes(1);

		act(() => useBoardAskStore.getState().clearIdea("p1"));
		await act(async () => answer({ success: true, data: judged }));
		expect(useBoardAskStore.getState().ideas.p1).toBeUndefined();
	});
});

describe("board-ask-store ideas", () => {
	it("marks no card on a project without a check", () => {
		const before = useBoardAskStore.getState().ideas;
		useBoardAskStore.getState().markIdeaCard("nope", "t9");
		expect(useBoardAskStore.getState().ideas).toBe(before);
	});
});
