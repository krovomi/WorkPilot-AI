/**
 * The bridge between a feature store's own phase and the activity registry.
 *
 * What is pinned here is that a feature does not have to be hooked action by
 * action: the four ways a job can end (complete, error, cancel, reset) are all
 * covered by reading the phase, which is the property that made one bridge
 * enough for nineteen stores.
 */

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";

import { bridgePhaseActivity } from "../activity-bridge";
import { selectViewBadge, useActivityStore } from "../activity-store";
import { useProjectStore } from "../project-store";

interface FakeState {
	phase: string;
	error: string | null;
	set: (phase: string, error?: string | null) => void;
}

function makeStore() {
	return create<FakeState>((set) => ({
		phase: "idle",
		error: null,
		set: (phase, error = null) => set({ phase, error }),
	}));
}

function badge() {
	return selectViewBadge(
		useActivityStore.getState().activities,
		"doc-drift",
		"p1",
	);
}

describe("bridgePhaseActivity", () => {
	beforeEach(() => {
		act(() => {
			useActivityStore.setState({
				activities: [],
				activeView: null,
				attention: null,
			});
			useProjectStore.setState({ selectedProjectId: "p1" } as never);
		});
	});

	it("registers the work while the store is in a running phase", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("scanning"));

		expect(badge()).toMatchObject({ status: "running", count: 1 });
	});

	it("names the job after the phase that is running", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("analyzing"));

		expect(badge()?.activity?.labelKey).toBe(
			"navigation:activity.kinds.analyzing",
		);
	});

	it("reports a completion, carrying nothing to apologise for", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("scanning"));
		act(() => store.getState().set("complete"));

		expect(badge()).toMatchObject({ status: "success", count: 1 });
	});

	it("carries the store's own error message into the failure", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("scanning"));
		act(() => store.getState().set("error", "no project selected"));

		expect(badge()).toMatchObject({ status: "error" });
		expect(badge()?.activity?.detail).toBe("no project selected");
	});

	it("leaves no badge when the work is cancelled back to idle", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("scanning"));
		act(() => store.getState().set("idle"));

		// Nothing was produced, so there is nothing to come back and look at.
		expect(badge()).toBeNull();
		expect(useActivityStore.getState().activities).toHaveLength(0);
	});

	it("accepts `ready` as a completion, for the store that says it that way", () => {
		const store = makeStore();
		bridgePhaseActivity(store, "doc-drift");

		act(() => store.getState().set("generating"));
		act(() => store.getState().set("ready"));

		expect(badge()).toMatchObject({ status: "success" });
	});

	it("stops reporting once unsubscribed", () => {
		const store = makeStore();
		const unsubscribe = bridgePhaseActivity(store, "doc-drift");
		unsubscribe();

		act(() => store.getState().set("scanning"));

		expect(badge()).toBeNull();
	});
});
