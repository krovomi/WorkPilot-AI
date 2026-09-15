/**
 * Tests for the activity registry behind the sidebar badges.
 *
 * The properties pinned here are the ones that decide whether the menu reads
 * as a signal or as a Christmas tree: one animation at a time, severity wins
 * it, a page the user is watching never badges itself, and a visit clears what
 * it answered.
 */

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ATTENTION_MS,
	finishActivity,
	selectGroupBadge,
	selectViewBadge,
	startActivity,
	useActivityStore,
} from "../activity-store";

function reset(): void {
	act(() => {
		useActivityStore.setState({
			activities: [],
			activeView: null,
			attention: null,
		});
	});
}

function begin(id: string, view: "kanban" | "ideation" | "insights"): void {
	act(() => {
		startActivity({
			id,
			view,
			projectId: "p1",
			labelKey: "navigation:activity.kinds.build",
		});
	});
}

describe("activity store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		reset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("badges a page that has work running", () => {
		begin("a", "ideation");

		const badge = selectViewBadge(
			useActivityStore.getState().activities,
			"ideation",
			"p1",
		);
		expect(badge).toMatchObject({ status: "running", count: 1 });
	});

	it("does not badge a page belonging to another project", () => {
		begin("a", "ideation");

		expect(
			selectViewBadge(useActivityStore.getState().activities, "ideation", "p2"),
		).toBeNull();
	});

	it("shows the worst state of a page, and counts only its peers", () => {
		begin("a", "ideation");
		begin("b", "ideation");
		begin("c", "ideation");
		act(() => {
			finishActivity("b", "success");
			finishActivity("c", "error", "boom");
		});

		expect(
			selectViewBadge(useActivityStore.getState().activities, "ideation", "p1"),
		).toMatchObject({ status: "error", count: 1 });
	});

	it("rolls a folded group up to the worst state among its entries", () => {
		begin("a", "ideation");
		begin("b", "insights");
		act(() => finishActivity("b", "error"));

		expect(
			selectGroupBadge(
				useActivityStore.getState().activities,
				["ideation", "insights"],
				"p1",
			),
		).toMatchObject({ status: "error", count: 1 });
	});

	it("hands the single animation slot to the job that just ended", () => {
		begin("a", "ideation");
		act(() => finishActivity("a", "success"));

		expect(useActivityStore.getState().attention?.view).toBe("ideation");

		act(() => vi.advanceTimersByTime(ATTENTION_MS + 1));

		// The badge stays; the motion does not.
		expect(useActivityStore.getState().attention).toBeNull();
		expect(
			selectViewBadge(useActivityStore.getState().activities, "ideation", "p1"),
		).toMatchObject({ status: "success", count: 1 });
	});

	it("lets a failure keep the slot a later success would have stolen", () => {
		begin("a", "ideation");
		begin("b", "insights");

		act(() => finishActivity("a", "error"));
		act(() => finishActivity("b", "success"));

		expect(useActivityStore.getState().attention?.view).toBe("ideation");
		expect(useActivityStore.getState().attention?.status).toBe("error");
	});

	it("stays silent for work that ends on the page being watched", () => {
		act(() => useActivityStore.getState().setActiveView("ideation"));
		begin("a", "ideation");
		act(() => finishActivity("a", "success"));

		expect(useActivityStore.getState().attention).toBeNull();
		expect(
			selectViewBadge(useActivityStore.getState().activities, "ideation", "p1"),
		).toBeNull();
	});

	it("clears a page's badge when the user goes there", () => {
		begin("a", "ideation");
		act(() => finishActivity("a", "error", "boom"));

		act(() => useActivityStore.getState().setActiveView("ideation"));

		expect(
			selectViewBadge(useActivityStore.getState().activities, "ideation", "p1"),
		).toBeNull();
		// The record survives the read, for the activity centre to list.
		expect(useActivityStore.getState().activities).toHaveLength(1);
	});

	it("ignores a completion for work it never saw start", () => {
		act(() => finishActivity("ghost", "success"));

		expect(useActivityStore.getState().activities).toHaveLength(0);
		expect(useActivityStore.getState().attention).toBeNull();
	});

	it("replaces the previous record when the same job runs again", () => {
		begin("a", "ideation");
		act(() => finishActivity("a", "error"));
		begin("a", "ideation");

		const { activities } = useActivityStore.getState();
		expect(activities).toHaveLength(1);
		expect(activities[0].status).toBe("running");
	});
});

describe("what a badge stands for", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		reset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("carries the job itself when it stands for exactly one", () => {
		act(() =>
			startActivity({
				id: "task:7",
				view: "kanban",
				projectId: "p1",
				labelKey: "navigation:activity.kinds.build",
				label: "Refactor the parser",
			}),
		);

		const badge = selectViewBadge(
			useActivityStore.getState().activities,
			"kanban",
			"p1",
		);
		expect(badge?.activity?.label).toBe("Refactor the parser");
	});
});
