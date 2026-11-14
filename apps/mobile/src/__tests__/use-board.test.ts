import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState } from "react-native";
import { useBoard } from "../board/useBoard";

const mockApi = { cards: jest.fn(), streamInfo: jest.fn() };
const mockClient: { currentAccessToken: string | null; activeOrgId: string | null } = {
	currentAccessToken: "access-1",
	activeOrgId: "org-1",
};
let mockServerUrl: string | null = "https://wp.example.com";
let mockSessionApi: typeof mockApi | null = mockApi;
jest.mock("../auth/session", () => ({
	useSession: () => ({ api: mockSessionApi, client: mockClient, serverUrl: mockServerUrl }),
}));

/** A WebSocket the test drives: it records how it was opened and lets the test open, message and close it. */
class FakeSocket {
	static all: FakeSocket[] = [];
	static failNext = false;
	onopen: (() => void) | null = null;
	onmessage: ((message: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	closed = false;
	constructor(
		readonly url: string,
		readonly protocols: unknown,
		readonly options: { headers: Record<string, string> },
	) {
		if (FakeSocket.failNext) {
			FakeSocket.failNext = false;
			throw new Error("refused");
		}
		FakeSocket.all.push(this);
	}
	close() {
		this.closed = true;
	}
}

let appStateListener: ((state: string) => void) | null = null;
const removeListener = jest.fn();
const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
	jest.useFakeTimers();
	FakeSocket.all = [];
	FakeSocket.failNext = false;
	mockApi.cards.mockReset().mockResolvedValue([{ id: "001" }]);
	mockApi.streamInfo.mockReset().mockResolvedValue({ url: null });
	mockClient.currentAccessToken = "access-1";
	mockClient.activeOrgId = "org-1";
	mockServerUrl = "https://wp.example.com";
	mockSessionApi = mockApi;
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
	Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
	jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
		appStateListener = listener as (state: string) => void;
		return { remove: removeListener } as unknown as ReturnType<typeof AppState.addEventListener>;
	});
});

afterEach(() => {
	jest.useRealTimers();
	jest.restoreAllMocks();
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket;
});

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

describe("useBoard", () => {
	it("reads the cards, polls every 5 s while the stream is down, and keeps the cards on a failed read", async () => {
		const { result } = await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(result.current.cards).toEqual([{ id: "001" }]));
		expect(result.current.live).toBe(false);
		const reads = mockApi.cards.mock.calls.length;

		mockApi.cards.mockRejectedValueOnce(new Error("offline"));
		await act(async () => {
			jest.advanceTimersByTime(5_000);
		});
		await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
		expect(mockApi.cards.mock.calls.length).toBe(reads + 1);
		expect(result.current.cards).toEqual([{ id: "001" }]);

		await act(async () => {
			await result.current.reload();
		});
		expect(result.current.error).toBeNull();
		expect(result.current.refreshing).toBe(false);
	});

	it("opens the stream with the token in the header, never the URL, and reads on each board event", async () => {
		mockApi.streamInfo.mockResolvedValue({ url: "wss://wp.example.com/ws" });
		const { result } = await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		const socket = FakeSocket.all[0];
		expect(socket.url).not.toContain("access-1");
		expect(socket.url).toContain(encodeURIComponent("project:p1"));
		expect(socket.options.headers).toEqual({ Authorization: "Bearer access-1", "X-WorkPilot-Org": "org-1" });

		await act(async () => socket.onopen?.());
		expect(result.current.live).toBe(true);
		const reads = mockApi.cards.mock.calls.length;

		// Not a board event, and not JSON: ignored.
		await act(async () => socket.onmessage?.({ data: JSON.stringify({ event_type: "chat", data: {} }) }));
		await act(async () => socket.onmessage?.({ data: "not json" }));
		// Two board events in a row: one read after the debounce.
		await act(async () => socket.onmessage?.({ data: JSON.stringify({ event_type: "spec_created" }) }));
		await act(async () => socket.onmessage?.({ data: JSON.stringify({ event_type: "spec_updated" }) }));
		await act(async () => {
			jest.advanceTimersByTime(300);
		});
		expect(mockApi.cards.mock.calls.length).toBe(reads + 1);
	});

	it("sends no organization header without an active organization", async () => {
		mockClient.activeOrgId = null;
		mockApi.streamInfo.mockResolvedValue({ url: "wss://wp.example.com/ws" });
		await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		expect(FakeSocket.all[0].options.headers).toEqual({ Authorization: "Bearer access-1" });
	});

	it("opens the stream again after it drops, then stops everything when the screen leaves", async () => {
		mockApi.streamInfo.mockResolvedValue({ url: "wss://wp.example.com/ws" });
		const { result, unmount } = await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		await act(async () => FakeSocket.all[0].onopen?.());
		await act(async () => FakeSocket.all[0].onclose?.());
		expect(result.current.live).toBe(false);

		await act(async () => {
			jest.advanceTimersByTime(2_000);
		});
		await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
		// A late close of the old socket changes nothing.
		await act(async () => FakeSocket.all[0].onclose?.());
		expect(FakeSocket.all).toHaveLength(2);

		await unmount();
		expect(FakeSocket.all[1].closed).toBe(true);
		expect(removeListener).toHaveBeenCalled();
	});

	it("retries when the stream address, the token or the socket is missing", async () => {
		// No stream address can be derived from a server URL that is not http(s).
		mockServerUrl = "ftp://wp.example.com";
		const { unmount } = await renderHook(() => useBoard("p1"));
		await flush();
		expect(FakeSocket.all).toHaveLength(0);
		expect(mockApi.streamInfo).toHaveBeenCalledTimes(1);
		await act(async () => {
			jest.advanceTimersByTime(2_000);
		});
		await waitFor(() => expect(mockApi.streamInfo).toHaveBeenCalledTimes(2));

		// The stream info cannot be read.
		mockApi.streamInfo.mockRejectedValueOnce(new Error("401"));
		await act(async () => {
			jest.advanceTimersByTime(5_000);
		});
		await waitFor(() => expect(mockApi.streamInfo).toHaveBeenCalledTimes(3));
		expect(FakeSocket.all).toHaveLength(0);
		await unmount();
	});

	it("retries when there is no access token, and when the socket cannot be built", async () => {
		mockClient.currentAccessToken = null;
		mockApi.streamInfo.mockResolvedValue({ url: "wss://wp.example.com/ws" });
		const { unmount } = await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(mockApi.streamInfo).toHaveBeenCalledTimes(1));
		expect(FakeSocket.all).toHaveLength(0);

		mockClient.currentAccessToken = "access-2";
		FakeSocket.failNext = true;
		await act(async () => {
			jest.advanceTimersByTime(2_000);
		});
		await waitFor(() => expect(mockApi.streamInfo).toHaveBeenCalledTimes(2));
		expect(FakeSocket.all).toHaveLength(0);

		await act(async () => {
			jest.advanceTimersByTime(5_000);
		});
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		expect(FakeSocket.all[0].options.headers.Authorization).toBe("Bearer access-2");
		await unmount();
	});

	it("stops polling and streaming in the background, and starts again on return", async () => {
		mockApi.streamInfo.mockResolvedValue({ url: "wss://wp.example.com/ws" });
		await renderHook(() => useBoard("p1"));
		await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		await act(async () => appStateListener?.("background"));
		expect(FakeSocket.all[0].closed).toBe(true);
		const reads = mockApi.cards.mock.calls.length;
		await act(async () => {
			jest.advanceTimersByTime(30_000);
		});
		expect(mockApi.cards.mock.calls.length).toBe(reads);

		await act(async () => appStateListener?.("active"));
		await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
		expect(mockApi.cards.mock.calls.length).toBeGreaterThan(reads);
	});

	it("drops a stream that opens after the screen left", async () => {
		let answer: (value: { url: string }) => void = () => {};
		mockApi.streamInfo.mockReturnValue(new Promise((r) => (answer = r)));
		const { unmount } = await renderHook(() => useBoard("p1"));
		await unmount();
		await act(async () => answer({ url: "wss://wp.example.com/ws" }));
		expect(FakeSocket.all).toHaveLength(0);
	});

	it("does nothing without a signed-in session", async () => {
		mockSessionApi = null;
		mockServerUrl = null;
		const { result } = await renderHook(() => useBoard("p1"));
		await flush();
		await act(async () => {
			await result.current.reload();
		});
		expect(result.current.cards).toBeNull();
		expect(mockApi.cards).not.toHaveBeenCalled();
		expect(mockApi.streamInfo).not.toHaveBeenCalled();
	});

	it("does not read twice at once", async () => {
		let release: (value: unknown) => void = () => {};
		mockApi.cards.mockReturnValue(new Promise((r) => (release = r)));
		const { result } = await renderHook(() => useBoard("p1"));
		await act(async () => {
			void result.current.reload();
		});
		expect(mockApi.cards).toHaveBeenCalledTimes(1);
		await act(async () => release([]));
		await waitFor(() => expect(result.current.cards).toEqual([]));
	});
});
