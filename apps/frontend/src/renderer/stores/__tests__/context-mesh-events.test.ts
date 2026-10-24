/**
 * @vitest-environment jsdom
 *
 * A Context Mesh analysis reports through four events. Nothing listened to
 * them, so the dashboard stayed on "Starting analysis..." for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	subscribeContextMeshEvents,
	useContextMeshStore,
} from "../context-mesh-store";

type Listener = (value: unknown) => void;
const listeners = new Map<string, Listener>();
const invoke = vi.fn().mockResolvedValue({ success: true, data: [] });

beforeEach(() => {
	listeners.clear();
	invoke.mockClear();
	const on = (name: string) => (callback: Listener) => {
		listeners.set(name, callback);
		return () => listeners.delete(name);
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		invoke,
		onContextMeshStatus: on("status"),
		onContextMeshStreamChunk: on("chunk"),
		onContextMeshError: on("error"),
		onContextMeshComplete: on("complete"),
	};
	useContextMeshStore.getState().reset();
	useContextMeshStore.getState().setPhase("analyzing");
});

describe("subscribeContextMeshEvents", () => {
	it("follows the status and the streamed output", () => {
		subscribeContextMeshEvents();
		listeners.get("status")?.("Comparing projects");
		listeners.get("chunk")?.("first ");
		listeners.get("chunk")?.("second");
		const state = useContextMeshStore.getState();
		expect(state.status).toBe("Comparing projects");
		expect(state.streamingOutput).toBe("first second");
	});

	it("ends the run and reloads the mesh on completion", () => {
		subscribeContextMeshEvents();
		listeners.get("complete")?.({});
		expect(useContextMeshStore.getState().phase).toBe("complete");
		expect(invoke).toHaveBeenCalled();
	});

	it("shows the error", () => {
		subscribeContextMeshEvents();
		listeners.get("error")?.("backend unreachable");
		const state = useContextMeshStore.getState();
		expect(state.phase).toBe("error");
		expect(state.error).toBe("backend unreachable");
	});

	it("stops listening when cleaned up", () => {
		const cleanup = subscribeContextMeshEvents();
		cleanup();
		expect(listeners.size).toBe(0);
	});
});
