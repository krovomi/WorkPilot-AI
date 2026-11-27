/**
 * « Interroger le tableau »: the panel asks the main process with the
 * conversation so far, shows the answer with its cited tickets, opens a ticket,
 * and says when only the keyword search answered.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import type { BoardAskResult, Task } from "../../../../shared/types";
import { turnAnswer, useBoardAskStore } from "../../../stores/board-ask-store";
import { useTaskStore } from "../../../stores/task-store";
import { BoardAskButton } from "./BoardAskButton";

const aiResult: BoardAskResult = {
	answer: "The admin page was rebuilt [1]; exports are planned [2].",
	matches: [
		{ taskId: "t1", title: "Refonte de la page d'administration", state: "done", coverage: "full", reason: "Rebuilt it", updatedAt: "2026-11-02T10:00:00.000Z", archived: true },
		{ taskId: "t2", title: "Export CSV", state: "planned", coverage: "partial" },
	],
	mode: "ai",
	searched: 12,
};

let api: RendererApi;
let askBoard: ReturnType<typeof vi.fn>;

beforeEach(() => {
	askBoard = vi.fn(async () => ({ success: true, data: aiResult }));
	api = installRendererApi({ askBoard });
	useBoardAskStore.setState({ open: false, conversations: {} });
	useTaskStore.setState({ tasks: [{ id: "t1", title: "Refonte de la page d'administration" } as Task] });
});
afterEach(() => api.restore());

describe("BoardAskPanel", () => {
	it("asks, shows the cited answer, and opens a ticket", async () => {
		const onOpenTask = vi.fn();
		render(<BoardAskButton projectId="p1" onOpenTask={onOpenTask} />);
		await userEvent.click(screen.getByRole("button", { name: "Ask" }));
		await userEvent.type(screen.getByRole("textbox", { name: /Ask a question/ }), "How was the admin page reworked?{Enter}");

		expect(await screen.findByText("Answered by AI")).toBeInTheDocument();
		expect(askBoard).toHaveBeenCalledWith({ projectId: "p1", question: "How was the admin page reworked?", history: [] });
		expect(screen.getByText("12 tickets searched")).toBeInTheDocument();
		expect(screen.getByText("Already covered")).toBeInTheDocument();
		expect(screen.getByText("Partly covered")).toBeInTheDocument();
		expect(screen.getByText("Archived")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Ticket 1: Refonte de la page d'administration" })).toBeInTheDocument();

		// The second ticket is not on this board's store: nothing to open.
		expect(screen.getByRole("button", { name: /^2\s*Export CSV/ })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: /Rebuilt it/ }));
		expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
		expect(useBoardAskStore.getState().open).toBe(false);
	});

	it("sends the conversation with a follow-up, and starts over", async () => {
		useBoardAskStore.setState({ open: true });
		render(<BoardAskButton projectId="p1" />);
		const box = screen.getByRole("textbox", { name: /Ask a question/ });
		await userEvent.type(box, "Admin page?{Enter}");
		await screen.findByText("Answered by AI");
		await userEvent.type(box, "And exports?{Enter}");
		await waitFor(() => expect(askBoard).toHaveBeenCalledTimes(2));
		expect(askBoard.mock.calls[1]?.[0]).toMatchObject({
			question: "And exports?",
			history: [{ question: "Admin page?", answer: aiResult.answer }],
		});
		await userEvent.click(await screen.findByRole("button", { name: "New conversation" }));
		expect(useBoardAskStore.getState().conversations.p1).toBeUndefined();
	});

	it("says when the keyword search answered alone, when nothing relates, and when it failed", async () => {
		askBoard
			.mockResolvedValueOnce({
				success: true,
				data: { answer: "", matches: [{ taskId: "t1", title: "Admin", state: "in_progress" }], mode: "keywords", searched: 1 },
			})
			.mockResolvedValueOnce({ success: true, data: { answer: "", matches: [], mode: "keywords", searched: 3 } })
			.mockResolvedValueOnce({ success: false, error: "server_project" })
			.mockRejectedValueOnce(new Error("boom"));
		useBoardAskStore.setState({ open: true });
		render(<BoardAskButton projectId="p1" />);
		const box = screen.getByRole("textbox", { name: /Ask a question/ });
		await userEvent.type(box, "admin{Enter}");
		expect(await screen.findByText(/these tickets share words with the question/)).toBeInTheDocument();
		expect(screen.getByText("In progress")).toBeInTheDocument();
		await userEvent.type(box, "nothing{Enter}");
		expect(await screen.findByText("No ticket relates to this question.")).toBeInTheDocument();
		await userEvent.type(box, "server{Enter}");
		expect(await screen.findByText("A server board cannot be asked yet.")).toBeInTheDocument();
		await userEvent.type(box, "boom{Enter}");
		expect(await screen.findByText(/could not be answered/)).toBeInTheDocument();
	});

	it("a citation points at its own answer's ticket, not an earlier answer's", async () => {
		useBoardAskStore.setState({ open: true });
		render(<BoardAskButton projectId="p1" />);
		const box = screen.getByRole("textbox", { name: /Ask a question/ });
		await userEvent.type(box, "first{Enter}");
		await screen.findByText("Answered by AI");
		await userEvent.type(box, "second{Enter}");
		await waitFor(() => expect(screen.getAllByText("Answered by AI")).toHaveLength(2));
		const citations = screen.getAllByRole("button", { name: "Ticket 1: Refonte de la page d'administration" });
		await userEvent.click(citations[1] as HTMLElement);
		const rows = screen.getAllByRole("button", { name: /Rebuilt it/ });
		expect(rows[0]).not.toHaveAttribute("aria-current");
		expect(rows[1]).toHaveAttribute("aria-current", "true");
	});

	it("asks an example question from the empty state", async () => {
		useBoardAskStore.setState({ open: true });
		render(<BoardAskButton projectId="p1" />);
		await userEvent.click(screen.getByRole("button", { name: "How was the admin page reworked?" }));
		await waitFor(() => expect(askBoard).toHaveBeenCalled());
	});
});

describe("turnAnswer", () => {
	it("is the model's answer, else the tickets listed", () => {
		expect(turnAnswer(aiResult)).toBe(aiResult.answer);
		expect(turnAnswer({ ...aiResult, answer: "" })).toBe("[1] Refonte de la page d'administration\n[2] Export CSV");
	});
});
