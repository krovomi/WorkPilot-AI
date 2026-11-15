/** @vitest-environment jsdom */
/**
 * The Context view's Lifecycle tab (#348, #352), and the pin / forget /
 * history actions each local memory card carries in the Memories tab.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { MemoryEpisode, MemoryStatus } from "../../../../shared/types";

const state = vi.hoisted(() => ({
	store: {} as Record<string, unknown>,
	loadRecentMemories: vi.fn(),
}));

vi.mock("../../../hooks/useServerViewLive", () => ({ useServerViewLive: vi.fn() }));
vi.mock("../../../stores/context-store", () => ({
	useContextStore: () => state.store,
	loadRecentMemories: state.loadRecentMemories,
}));
vi.mock("../hooks", () => ({
	useProjectContext: vi.fn(),
	useRefreshIndex: () => vi.fn(),
	useMemorySearch: () => vi.fn(),
}));
vi.mock("../ProjectIndexTab", () => ({ ProjectIndexTab: () => <div>project index</div> }));

import { Context } from "../Context";

const MEMORY: MemoryEpisode = {
	id: "m1",
	type: "session_insight",
	timestamp: "2026-11-14T10:00:00+00:00",
	content: "Never push on Friday.",
	session_number: 7,
	path: "knowledge/projects/shop/memory/gotchas/never-push-on-friday.md",
	pinned: false,
};

const api = {
	pinMemory: vi.fn(),
	getMemoryLifecycle: vi.fn(),
};

function storeWith(status: MemoryStatus) {
	state.store = {
		projectIndex: null,
		indexLoading: false,
		indexError: null,
		memoryStatus: status,
		memoryState: null,
		recentMemories: [MEMORY],
		memoriesLoading: false,
		searchResults: [],
		searchLoading: false,
	};
}

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	state.loadRecentMemories.mockReset();
	api.getMemoryLifecycle.mockResolvedValue({
		success: true,
		data: { journal: [], trash: [], conflicts: [], pinned: 0, pinLimit: 50, retentionDays: 30 },
	});
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	storeWith({ enabled: true, available: true });
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

describe("the Context view", () => {
	it("pins a local memory from its card and reads the list again", async () => {
		api.pinMemory.mockResolvedValue({ success: true, data: { count: 1 } });
		render(<Context projectId="p1" />);
		expect(screen.getByText("project index")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Memories" }));
		fireEvent.click(await screen.findByRole("button", { name: "Pin" }));
		await waitFor(() => expect(state.loadRecentMemories).toHaveBeenCalledWith("p1"));
		expect(api.pinMemory).toHaveBeenCalledWith("p1", MEMORY.path, true);
	});

	it("opens the Lifecycle tab on the project's memory", async () => {
		render(<Context projectId="p1" />);
		fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
		expect(await screen.findByText("No conflict waiting.")).toBeInTheDocument();
		expect(api.getMemoryLifecycle).toHaveBeenCalledWith("p1");
	});

	it("offers no action and no lifecycle for a server project's memory", () => {
		storeWith({ enabled: true, available: true, onServer: true });
		render(<Context projectId="p1" />);
		fireEvent.click(screen.getByRole("tab", { name: "Memories" }));
		expect(screen.getByText(/Session #7/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
		expect(screen.getByText(/not available yet/)).toBeInTheDocument();
		expect(api.getMemoryLifecycle).not.toHaveBeenCalled();
	});
});
