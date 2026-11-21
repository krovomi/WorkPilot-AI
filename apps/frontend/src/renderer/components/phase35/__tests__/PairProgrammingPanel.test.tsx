/** @vitest-environment jsdom */
/**
 * A pair room on the open project: joining, the room's file, the chat, the
 * AI participant, and leaving.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAIR_AI_USER_ID, usePairRealtimeStore } from "../../../stores/phase35-stores";
import { PairProgrammingPanel } from "../PairProgrammingPanel";
import { type Api, openWorld } from "./phase35-world";

const participant = (user_id: string, display_name: string, role: "driver" | "navigator" | "ai") => ({
	user_id,
	display_name,
	role,
	joined_at: 0,
	last_seen: 0,
});
const room = (participants = [participant("ana-maria", "Ana Maria", "navigator")]) => ({
	room_id: "shop",
	created_at: 0,
	participants,
	op_count: 0,
	last_op_sequence: 0,
	closed: false,
});

let api: Api;
beforeEach(async () => {
	api = await openWorld({
		createPairRoom: async () => ({ success: true }),
		pairJoin: async () => ({ success: true }),
		getPairRoom: async () => ({ success: true, room: room() }),
		subscribePairRoom: async () => ({ success: true, subscriptionId: "s1" }),
		unsubscribePairRoom: async () => ({ success: true }),
		pairLeave: async () => ({ success: true }),
		pairChat: async () => ({ success: true }),
		pairCursor: async () => ({ success: true }),
	});
});
afterEach(cleanup);

async function join() {
	render(<PairProgrammingPanel projectPath="/work/shop" />);
	fireEvent.change(screen.getByLabelText("Room ID"), { target: { value: " shop " } });
	fireEvent.change(screen.getByLabelText("Your display name"), { target: { value: " Ana Maria " } });
	fireEvent.change(screen.getByLabelText("Role"), { target: { value: "navigator" } });
	fireEvent.click(screen.getByRole("button", { name: "Join room" }));
	await screen.findByText("Streaming live");
}

describe("PairProgrammingPanel", () => {
	it("asks for a project", () => {
		render(<PairProgrammingPanel />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
	});

	it("checks the room ID and the name before joining", () => {
		render(<PairProgrammingPanel projectPath="/work/shop" />);
		expect(screen.getByText("Enter your display name")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Room ID"), { target: { value: "  " } });
		expect(screen.getByText("Enter a room ID")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Room ID"), { target: { value: "a room" } });
		expect(screen.getByText(/Invalid room ID/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Join room" })).toBeDisabled();
	});

	it("joins the room under an id made from the name, and streams it", async () => {
		await join();
		expect(api.pairJoin).toHaveBeenCalledWith("shop", "ana-maria", "Ana Maria", "navigator");
		expect(api.subscribePairRoom).toHaveBeenCalledWith("shop", 0);
		expect(screen.getByText(/room : shop/)).toBeInTheDocument();
		expect(screen.getByText("Participants (1)")).toBeInTheDocument();
		expect(screen.getByText("(Navigator)")).toBeInTheDocument();
		expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
		expect(screen.getByText("No file: the AI only reads the conversation.")).toBeInTheDocument();
	});

	it("names a user 'me' when the name holds no letter it can use", async () => {
		render(<PairProgrammingPanel projectPath="/work/shop" />);
		fireEvent.change(screen.getByLabelText("Your display name"), { target: { value: "日本" } });
		fireEvent.click(screen.getByRole("button", { name: "Join room" }));
		await waitFor(() => expect(api.pairJoin).toHaveBeenCalledWith("pair", "me", "日本", "driver"));
	});

	it("chats, points the room at a file, and shows what happens in it", async () => {
		await join();
		const box = screen.getByLabelText("Type a message…");
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		fireEvent.change(box, { target: { value: "  hello  " } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(api.pairChat).toHaveBeenCalledWith("shop", "ana-maria", "hello"));
		expect(box).toHaveValue("");

		const file = screen.getByLabelText("File path, relative to the project");
		fireEvent.keyDown(file, { key: "Enter" });
		expect(api.pairCursor).not.toHaveBeenCalled();
		fireEvent.change(file, { target: { value: "/work/shop/src/Orders.cs" } });
		fireEvent.keyDown(file, { key: "x" });
		fireEvent.keyDown(file, { key: "Enter" });
		await waitFor(() => expect(api.pairCursor).toHaveBeenCalledWith("shop", "ana-maria", "src/Orders.cs", 0, 0));
		expect(file).toHaveValue("");
		fireEvent.change(file, { target: { value: "src/Cart.cs" } });
		fireEvent.click(screen.getByRole("button", { name: "Work on this file" }));
		await waitFor(() => expect(api.pairCursor).toHaveBeenCalledWith("shop", "ana-maria", "src/Cart.cs", 0, 0));

		const op = (sequence: number, kind: string, payload: Record<string, unknown>, actor = "ana-maria") => ({
			op_id: `o${sequence}`,
			sequence,
			kind,
			actor,
			timestamp: 0,
			payload,
		});
		act(() =>
			usePairRealtimeStore.setState({
				ops: [
					op(1, "chat", { text: "hi there" }),
					op(2, "edit", { file_path: "src/Cart.cs" }),
					op(3, "chat", { text: 42 }, "ghost"),
					op(4, "teleport", {}),
				] as never,
			}),
		);
		expect(screen.getByText("hi there")).toBeInTheDocument();
		expect(screen.getAllByText("src/Cart.cs")).toHaveLength(2);
		// Someone no longer in the room keeps the id they wrote under.
		expect(screen.getByText("ghost")).toBeInTheDocument();
		expect(screen.getByText("teleport")).toBeInTheDocument();
	});

	it("picks the room's file in a dialog, and says when the dialog fails", async () => {
		await join();
		api.selectFiles.mockResolvedValueOnce([]).mockResolvedValueOnce(["/work/shop/README.md"]);
		fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
		await waitFor(() => expect(api.selectFiles).toHaveBeenCalledTimes(1));
		expect(api.pairCursor).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
		await waitFor(() => expect(api.pairCursor).toHaveBeenCalledWith("shop", "ana-maria", "README.md", 0, 0));
		api.selectFiles.mockRejectedValueOnce(new Error("no window"));
		fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The file dialog could not open.");
	});

	it("invites the AI, which then answers each message, and says when it cannot", async () => {
		await join();
		api.getPairRoom.mockResolvedValue({
			success: true,
			room: room([participant("ana-maria", "Ana Maria", "navigator"), participant(PAIR_AI_USER_ID, "WorkPilot AI", "ai")]),
		});
		api.pairAskAi.mockResolvedValue({ success: false, error: "empty" });
		fireEvent.click(screen.getByRole("button", { name: "Invite the AI" }));
		expect(await screen.findByRole("button", { name: "The AI is in the room" })).toBeDisabled();
		expect(api.pairJoin).toHaveBeenLastCalledWith("shop", PAIR_AI_USER_ID, "WorkPilot AI", "ai");
		expect(screen.getByText("(AI)")).toBeInTheDocument();
		const box = screen.getByLabelText("Type a message…");
		expect(box).toHaveAttribute("placeholder", "Write to the room: the AI will answer");
		fireEvent.change(box, { target: { value: "help" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(await screen.findByText("The provider returned an empty answer.")).toBeInTheDocument();
		act(() => usePairRealtimeStore.setState({ aiThinking: true, aiError: "brand_new" as never }));
		expect(screen.getByText("The AI is preparing its answer…")).toBeInTheDocument();
		expect(screen.queryByText("The provider returned an empty answer.")).not.toBeInTheDocument();
	});

	it("shows a dropped stream as offline, and leaves the room", async () => {
		await join();
		api.subscribePairRoom.mockResolvedValue({ success: false, error: "stream gone" });
		act(() => usePairRealtimeStore.setState({ isStreaming: false, subscriptionId: null }));
		expect(await screen.findByText("Offline")).toBeInTheDocument();
		act(() => usePairRealtimeStore.setState({ subscriptionId: "s1" }));
		fireEvent.click(screen.getByRole("button", { name: "Leave" }));
		expect(await screen.findByRole("button", { name: "Join room" })).toBeInTheDocument();
		expect(api.pairLeave).toHaveBeenCalledWith("shop", "ana-maria");
	});
});
