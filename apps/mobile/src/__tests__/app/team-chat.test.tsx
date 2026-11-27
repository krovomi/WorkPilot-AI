import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";
import { fakeServer, openApp, restoreFetch } from "../../../test-support/fake-server";

/** A stream that opens at once: it keeps what the phone sent, and the test speaks as the server. */
class RoomSocket {
	static all: RoomSocket[] = [];
	static failSend = false;
	sent: Record<string, unknown>[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((message: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor() {
		RoomSocket.all.push(this);
		queueMicrotask(() => this.onopen?.());
	}
	send(data: string) {
		if (RoomSocket.failSend) throw new Error("closed");
		this.sent.push(JSON.parse(data));
	}
	close() {}
}

const realWebSocket = globalThis.WebSocket;
const PROJECT = { id: "p1", name: "Shop", repo_url: "https://github.com/acme/shop", default_branch: "main", my_role: "member" };
const BOB = { id: "m-1", author_id: "u2", author: "Bob", message: "Is the cart ready?", reply_to: "", at: "2026-11-27T09:00:00Z" };
const MINE = { id: "m-2", author_id: "u1", author: "Ada Lovelace", message: "Almost", reply_to: "m-1", at: "2026-11-27T09:01:00Z" };
const ORPHAN = { id: "m-3", author_id: "u2", author: "Bob", message: "About the old one", reply_to: "m-0", at: "2026-11-27T09:02:00Z" };

/** The server speaks on every stream the screen opened. */
async function server(type: string, data: unknown) {
	await act(async () => {
		for (const socket of RoomSocket.all) socket.onmessage?.({ data: JSON.stringify({ event_type: type, data }) });
	});
}

function sent() {
	return RoomSocket.all.flatMap((s) => s.sent);
}

/** The chat open, live, with the person alone in the room. */
async function openChat(role = "member") {
	fakeServer({ "GET /projects/p1": { ...PROJECT, my_role: role } }, ["task.read"]);
	await openApp("/projects/p1/chat");
	await waitFor(() => expect(RoomSocket.all.length).toBeGreaterThan(0));
	await server("presence", { users: [{ id: "u1", name: "Ada Lovelace" }] });
	await screen.findByText("1 here");
}

beforeEach(() => {
	RoomSocket.all = [];
	RoomSocket.failSend = false;
	globalThis.WebSocket = RoomSocket as unknown as typeof WebSocket;
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	restoreFetch();
	jest.restoreAllMocks();
});

describe("team chat", () => {
	it("is a row of the project's More tab", async () => {
		fakeServer({ "GET /projects/p1": PROJECT }, ["task.read"]);
		await openApp("/projects/p1/more");
		await fireEvent.press(await screen.findByRole("button", { name: "Team chat" }));
		expect(await screen.findByText("Connecting…")).toBeTruthy();
	});

	it("shows who is here and the conversation, and sends a message and a reply", async () => {
		fakeServer({ "GET /projects/p1": PROJECT }, ["task.read"]);
		await openApp("/projects/p1/chat");
		expect(await screen.findByText("Connecting…")).toBeTruthy();
		await waitFor(() => expect(RoomSocket.all.length).toBeGreaterThan(0));
		await server("presence", { users: [{ id: "u1", name: "Ada Lovelace" }, { id: "u2", name: "Bob" }, { name: "no id" }, "x"] });
		expect(await screen.findByText("2 here")).toBeTruthy();
		expect(screen.getByText("You")).toBeTruthy();
		await server("chat_history", { messages: [BOB, MINE, ORPHAN, { id: "bad" }] });
		expect(await screen.findByText("Is the cart ready?")).toBeTruthy();
		expect(screen.getByText("Bob: Is the cart ready?")).toBeTruthy();
		expect(screen.getByText("About the old one")).toBeTruthy();
		// A longer conversation scrolls to its last message.
		await fireEvent(screen.getByText("About the old one"), "contentSizeChange", 320, 1200);

		await fireEvent.changeText(screen.getByLabelText("Message"), "  Ship it on Friday  ");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(sent()).toEqual([{ type: "chat_message", message: "Ship it on Friday" }]);
		expect(screen.getByLabelText("Message").props.value).toBe("");
		await server("chat_message", { ...MINE, id: "m-4", message: "Ship it on Friday", reply_to: "" });
		expect(await screen.findByText("Ship it on Friday")).toBeTruthy();
		// The same message twice is shown once.
		await server("chat_message", { ...MINE, id: "m-4", message: "Ship it on Friday", reply_to: "" });
		expect(screen.getAllByText("Ship it on Friday")).toHaveLength(1);

		await fireEvent.press(screen.getAllByRole("button", { name: "Reply to Bob" })[0]);
		expect(screen.getByText("Replying to Bob: Is the cart ready?")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Cancel the reply" }));
		expect(screen.queryByText(/Replying to Bob/)).toBeNull();
		await fireEvent.press(screen.getAllByRole("button", { name: "Reply to Bob" })[0]);
		await fireEvent.changeText(screen.getByLabelText("Message"), "Yes");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(sent()[1]).toEqual({ type: "chat_message", message: "Yes", reply_to: "m-1" });
		expect(screen.queryByText(/Replying to Bob/)).toBeNull();
	});

	it("says when the room has no message yet, and ignores what is not the room's", async () => {
		await openChat();
		await server("chat_history", {});
		expect(await screen.findByText("No message yet.")).toBeTruthy();
		await server("spec_updated", {});
		await server("chat_message", { id: "x" });
		await server("chat_rejected", { reason: "who knows" });
		await server("presence", {});
		expect(await screen.findByText("0 here")).toBeTruthy();
		expect(screen.queryByText(/Slow down/)).toBeNull();
	});

	it("puts a refused message back in the field and says why", async () => {
		await openChat();
		await server("chat_history", { messages: [] });
		await fireEvent.changeText(screen.getByLabelText("Message"), "One more");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		await server("chat_rejected", { reason: "too_fast" });
		expect(await screen.findByText(/Slow down: at most 5 messages/)).toBeTruthy();
		expect(screen.getByLabelText("Message").props.value).toBe("One more");

		// Typed meanwhile: the field keeps what was typed.
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		await fireEvent.changeText(screen.getByLabelText("Message"), "Something else");
		await server("chat_rejected", { reason: "unavailable" });
		expect(await screen.findByText(/cannot keep messages right now/)).toBeTruthy();
		expect(screen.getByLabelText("Message").props.value).toBe("Something else");
		// A refusal of nothing the phone sent changes nothing more.
		await server("chat_rejected", { reason: "invalid" });
		expect(await screen.findByText(/empty or longer than 2,000/)).toBeTruthy();
		expect(screen.getByLabelText("Message").props.value).toBe("Something else");
	});

	it("does not send a message the server would refuse, nor on a stream that just closed", async () => {
		await openChat();
		await server("chat_history", { messages: [] });
		await fireEvent.changeText(screen.getByLabelText("Message"), "x".repeat(2001));
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		RoomSocket.failSend = true;
		await fireEvent.changeText(screen.getByLabelText("Message"), "Hello");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		expect(sent()).toEqual([]);
		expect(screen.getByLabelText("Message").props.value).toBe("Hello");
	});

	it("lets a viewer read without offering to write", async () => {
		await openChat("viewer");
		await server("chat_history", { messages: [BOB] });
		expect(await screen.findByText("Is the cart ready?")).toBeTruthy();
		expect(screen.getByText(/lets you read the chat, not write in it/)).toBeTruthy();
		expect(screen.queryByLabelText("Message")).toBeNull();
		expect(screen.queryByRole("button", { name: "Reply to Bob" })).toBeNull();
	});

	it("stops offering to write once the server says the person may not", async () => {
		await openChat();
		await server("chat_history", { messages: [BOB] });
		await fireEvent.changeText(screen.getByLabelText("Message"), "Hi");
		await fireEvent.press(screen.getByRole("button", { name: "Send" }));
		await server("chat_rejected", { reason: "forbidden" });
		expect(await screen.findByText(/lets you read the chat, not write in it/)).toBeTruthy();
		expect(screen.queryByLabelText("Message")).toBeNull();
	});
});

