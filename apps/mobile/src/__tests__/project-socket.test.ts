import { act, renderHook } from "@testing-library/react-native";
import { useProjectSocket } from "../project/useProjectSocket";

const mockApi = { streamInfo: jest.fn() };
const mockClient = { currentAccessToken: "access-1", activeOrgId: null };
jest.mock("../auth/session", () => ({
	useSession: () => ({ api: mockApi, client: mockClient, serverUrl: "https://wp.example.com" }),
}));

class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((message: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];
	constructor() {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
	FakeSocket.all = [];
	mockApi.streamInfo.mockReset().mockResolvedValue({ url: null });
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
});

describe("useProjectSocket", () => {
	it("sends only once the stream is open, and not after it closed", async () => {
		const onEvent = jest.fn();
		const { result } = await renderHook(() => useProjectSocket("p1", true, { onEvent }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(FakeSocket.all).toHaveLength(1);
		expect(result.current.send({ type: "chat_message" })).toBe(false);
		await act(async () => FakeSocket.all[0].onopen?.());
		expect(result.current.live).toBe(true);
		expect(result.current.send({ type: "chat_message", message: "Hi" })).toBe(true);
		expect(JSON.parse(FakeSocket.all[0].sent[0])).toEqual({ type: "chat_message", message: "Hi" });
		// The room's history is longer than a board event may be.
		const history = JSON.stringify({ event_type: "chat_history", data: { messages: ["x".repeat(100_000)] } });
		await act(async () => FakeSocket.all[0].onmessage?.({ data: history }));
		expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "chat_history" }));
		await act(async () => FakeSocket.all[0].onclose?.());
		expect(result.current.send({ type: "chat_message" })).toBe(false);
	});
});
