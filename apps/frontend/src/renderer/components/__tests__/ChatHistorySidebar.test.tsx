/**
 * The Insights chat history: conversations grouped by day, opened with a
 * click, renamed or deleted from their menu.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { InsightsSessionSummary } from "../../../shared/types";
import { ChatHistorySidebar } from "../ChatHistorySidebar";
import { TooltipProvider } from "../ui/tooltip";

/** Thursday 20 November 2026, 09:00 local time. */
const NOW = new Date(2026, 10, 20, 9, 0, 0);

function session(id: string, title: string, updatedAt: Date, extra: Partial<InsightsSessionSummary> = {}): InsightsSessionSummary {
	return { id, projectId: "p1", title, messageCount: 1, createdAt: updatedAt, updatedAt, ...extra };
}

const props = {
	onNewSession: vi.fn(),
	onSelectSession: vi.fn(),
	onDeleteSession: vi.fn(),
	onRenameSession: vi.fn(),
};

function renderSidebar(sessions: InsightsSessionSummary[], extra: { currentSessionId?: string | null; isLoading?: boolean } = {}) {
	return render(
		<TooltipProvider>
			<ChatHistorySidebar
				sessions={sessions}
				currentSessionId={extra.currentSessionId ?? null}
				isLoading={extra.isLoading ?? false}
				{...props}
			/>
		</TooltipProvider>,
	);
}

/** Opens a conversation's menu (Radix opens it on pointer down). */
async function openMenu(title: string) {
	const row = screen.getByRole("button", { name: new RegExp(title) }).parentElement as HTMLElement;
	const trigger = within(row).getByRole("button", { name: "More options" });
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	return screen.findByRole("menu");
}

describe("ChatHistorySidebar", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		for (const fn of Object.values(props)) fn.mockReset();
		props.onDeleteSession.mockResolvedValue(true);
		props.onRenameSession.mockResolvedValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a spinner while the conversations load", () => {
		renderSidebar([session("s1", "Hidden", NOW)], { isLoading: true });
		expect(screen.getByRole("heading", { name: "Chat History" })).toBeInTheDocument();
		expect(screen.queryByText("Hidden")).toBeNull();
		expect(screen.queryByText("No conversations yet")).toBeNull();
	});

	it("says when there is no conversation yet, and starts one", async () => {
		renderSidebar([]);
		expect(screen.getByText("No conversations yet")).toBeInTheDocument();
		const add = screen.getByRole("button", { name: "New conversation" });
		fireEvent.focus(add);
		expect((await screen.findAllByText("New conversation")).length).toBeGreaterThan(0);
		await userEvent.click(add);
		expect(props.onNewSession).toHaveBeenCalledTimes(1);
	});

	it("groups the conversations by calendar day", () => {
		renderSidebar([
			session("s1", "This morning", new Date(2026, 10, 20, 8, 0)),
			// A clock a little ahead (a teammate's server) is still today.
			session("s2", "Ahead", new Date(2026, 10, 20, 11, 0)),
			// Ten hours ago, but yesterday evening.
			session("s3", "Last night", new Date(2026, 10, 19, 23, 0), { messageCount: 3 }),
			session("s4", "Monday", new Date(2026, 10, 16, 12, 0)),
			session("s5", "Long ago", new Date(2026, 10, 2, 12, 0)),
		]);

		const groups = ["Today", "Yesterday", "4 days ago"].map((label) => screen.getByText(label).parentElement as HTMLElement);
		expect(within(groups[0]).getByText("This morning")).toBeInTheDocument();
		expect(within(groups[0]).getByText("Ahead")).toBeInTheDocument();
		expect(within(groups[1]).getByText("Last night")).toBeInTheDocument();
		expect(within(groups[1]).getByText("3 messages")).toBeInTheDocument();
		expect(within(groups[2]).getByText("Monday")).toBeInTheDocument();
		expect(screen.getByText("Nov 2")).toBeInTheDocument();
		expect(screen.getAllByText("1 message")).toHaveLength(4);
	});

	it("opens a conversation and marks the current one", async () => {
		renderSidebar([session("s1", "First", NOW), session("s2", "Second", NOW)], { currentSessionId: "s2" });
		expect(screen.getByRole("button", { name: /Second/ })).toHaveAttribute("aria-current", "true");
		expect(screen.getByRole("button", { name: /First/ })).not.toHaveAttribute("aria-current");
		await userEvent.click(screen.getByRole("button", { name: /First/ }));
		expect(props.onSelectSession).toHaveBeenCalledWith("s1");
	});

	it("opening the menu does not open the conversation", async () => {
		renderSidebar([session("s1", "First", NOW)]);
		await userEvent.click(screen.getByRole("button", { name: "More options" }));
		expect(props.onSelectSession).not.toHaveBeenCalled();
	});

	it("shows a teammate's conversation read only, without rename nor delete", () => {
		renderSidebar([session("s1", "Shared plan", NOW, { readOnly: true, ownerName: "Ana" })]);
		expect(screen.getByText("By Ana, read only")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
	});

	it("renames a conversation with Enter or the save button", async () => {
		renderSidebar([session("s1", "Old title", NOW)]);
		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));

		const input = await screen.findByRole("textbox", { name: "Conversation title" });
		expect(input).toHaveValue("Old title");
		await userEvent.clear(input);
		await userEvent.type(input, "  New title  {Enter}");
		await waitFor(() => expect(props.onRenameSession).toHaveBeenCalledWith("s1", "New title"));
		expect(screen.queryByRole("textbox")).toBeNull();

		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		await userEvent.type(await screen.findByRole("textbox", { name: "Conversation title" }), " again");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(props.onRenameSession).toHaveBeenLastCalledWith("s1", "Old title again"));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("cancels a rename with Escape or the cancel button, and ignores an empty title", async () => {
		renderSidebar([session("s1", "Old title", NOW)]);
		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		await userEvent.type(await screen.findByRole("textbox"), "x{Escape}");
		expect(screen.queryByRole("textbox")).toBeNull();

		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		await userEvent.type(await screen.findByRole("textbox"), "y");
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("textbox")).toBeNull();

		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		const input = await screen.findByRole("textbox");
		await userEvent.clear(input);
		await userEvent.type(input, "   {Enter}");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(props.onRenameSession).not.toHaveBeenCalled();
		expect(screen.getByText("Old title")).toBeInTheDocument();
	});

	it("says when a rename did not go through", async () => {
		props.onRenameSession.mockResolvedValue(false);
		renderSidebar([session("s1", "Old title", NOW)]);
		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		await userEvent.type(await screen.findByRole("textbox"), "!{Enter}");
		expect(await screen.findByRole("alert")).toHaveTextContent("The conversation could not be renamed.");

		// Trying again clears the message.
		await userEvent.click(within(await openMenu("Old title")).getByRole("menuitem", { name: "Rename" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("deletes a conversation after confirmation", async () => {
		renderSidebar([session("s1", "To delete", NOW)]);
		await userEvent.click(within(await openMenu("To delete")).getByRole("menuitem", { name: "Delete" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Delete conversation?");
		expect(dialog).toHaveTextContent("This will permanently delete this conversation");
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

		expect(props.onDeleteSession).toHaveBeenCalledWith("s1");
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps the conversation when the deletion is cancelled", async () => {
		renderSidebar([session("s1", "To keep", NOW)]);
		await userEvent.click(within(await openMenu("To keep")).getByRole("menuitem", { name: "Delete" }));
		await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(props.onDeleteSession).not.toHaveBeenCalled();
	});

	it("says when a deletion did not go through", async () => {
		props.onDeleteSession.mockResolvedValue(false);
		renderSidebar([session("s1", "Stuck", NOW)]);
		await userEvent.click(within(await openMenu("Stuck")).getByRole("menuitem", { name: "Delete" }));
		await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The conversation could not be deleted.");

		await userEvent.click(within(await openMenu("Stuck")).getByRole("menuitem", { name: "Delete" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
