/**
 * @vitest-environment jsdom
 *
 * The Live Companion pushes its state, suggestions, takeover proposals and
 * file changes from main. Nothing listened, so the dashboard's list of recent
 * changes, fed by no call at all, stayed empty.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../../../shared/types/live-companion";
import {
	setupLiveCompanionListeners,
	useLiveCompanionStore,
} from "../live-companion-store";

type Listener = (value: unknown) => void;
const listeners = new Map<string, Listener>();

beforeEach(() => {
	listeners.clear();
	const on = (name: string) => (callback: Listener) => {
		listeners.set(name, callback);
		return () => listeners.delete(name);
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		onLiveCompanionStateChanged: on("state"),
		onLiveCompanionSuggestion: on("suggestion"),
		onLiveCompanionTakeoverProposal: on("takeover"),
		onLiveCompanionFileChange: on("fileChange"),
	};
	useLiveCompanionStore.getState().reset();
});

describe("setupLiveCompanionListeners", () => {
	it("follows the companion's state", () => {
		setupLiveCompanionListeners();
		const state = {
			...useLiveCompanionStore.getState().companionState,
			active: true,
			files_watched: 12,
		} satisfies CompanionState;
		listeners.get("state")?.(state);
		expect(useLiveCompanionStore.getState().companionState.files_watched).toBe(
			12,
		);
	});

	it("adds each pushed suggestion and takeover proposal", () => {
		setupLiveCompanionListeners();
		listeners.get("suggestion")?.({ suggestion_id: "s1" } as LiveSuggestion);
		listeners.get("takeover")?.({ proposal_id: "p1" } as TakeoverProposal);
		const store = useLiveCompanionStore.getState();
		expect(store.suggestions.map((s) => s.suggestion_id)).toEqual(["s1"]);
		expect(store.takeovers.map((t) => t.proposal_id)).toEqual(["p1"]);
	});

	it("lists the file changes, newest first", () => {
		setupLiveCompanionListeners();
		const change = (file_path: string): FileChangeEvent => ({
			file_path,
			change_type: "modified",
			diff: "",
			language: "typescript",
			timestamp: "2026-10-24T00:00:00Z",
		});
		listeners.get("fileChange")?.(change("a.ts"));
		listeners.get("fileChange")?.(change("b.ts"));
		expect(
			useLiveCompanionStore.getState().recentChanges.map((c) => c.file_path),
		).toEqual(["b.ts", "a.ts"]);
	});

	it("stops listening when cleaned up", () => {
		const cleanup = setupLiveCompanionListeners();
		cleanup();
		expect(listeners.size).toBe(0);
	});
});
