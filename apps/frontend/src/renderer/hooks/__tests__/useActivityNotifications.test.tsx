/**
 * The toast side of the activity registry.
 *
 * `use-toast` has a single slot, so the property worth pinning is the
 * coalescing: three pages finishing together must produce one announcement
 * rather than two that nobody ever sees.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

const toastMock = vi.fn();
vi.mock("../use-toast", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import { useActivityNotifications } from "../useActivityNotifications";
import {
	finishActivity,
	startActivity,
	useActivityStore,
} from "../../stores/activity-store";

function begin(id: string, view: "ideation" | "doc-drift" | "kanban") {
	act(() =>
		startActivity({
			id,
			view,
			projectId: "p1",
			labelKey: "navigation:activity.kinds.scanning",
		}),
	);
}

describe("useActivityNotifications", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		toastMock.mockClear();
		act(() => {
			useActivityStore.setState({
				activities: [],
				activeView: null,
				attention: null,
			});
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("announces one finished job by name", () => {
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("a", "doc-drift");
		act(() => finishActivity("a", "success"));
		act(() => vi.runAllTimers());

		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(toastMock.mock.calls[0][0].title).toContain(
			"activityCentre.toast.finishedOne",
		);
	});

	it("collects a burst into a single announcement", () => {
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("a", "doc-drift");
		begin("b", "ideation");
		act(() => {
			finishActivity("a", "success");
			finishActivity("b", "success");
		});
		act(() => vi.runAllTimers());

		expect(toastMock).toHaveBeenCalledTimes(1);
		expect(toastMock.mock.calls[0][0].title).toContain(
			"activityCentre.toast.finishedMany",
		);
	});

	it("lets a failure in the batch decide the wording and the variant", () => {
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("a", "doc-drift");
		begin("b", "ideation");
		act(() => {
			finishActivity("a", "success");
			finishActivity("b", "error", "boom");
		});
		act(() => vi.runAllTimers());

		expect(toastMock.mock.calls[0][0].variant).toBe("destructive");
		expect(toastMock.mock.calls[0][0].title).toContain(
			"activityCentre.toast.failedMany",
		);
	});

	it("says nothing about a Kanban build, which already has its own toast", () => {
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("task:1", "kanban");
		act(() => finishActivity("task:1", "success"));
		act(() => vi.runAllTimers());

		expect(toastMock).not.toHaveBeenCalled();
	});

	it("says nothing about work that ended on the page being watched", () => {
		act(() => useActivityStore.getState().setActiveView("doc-drift"));
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("a", "doc-drift");
		act(() => finishActivity("a", "success"));
		act(() => vi.runAllTimers());

		expect(toastMock).not.toHaveBeenCalled();
	});

	it("announces the same job again when it is run again", () => {
		renderHook(() => useActivityNotifications({ onNavigate: vi.fn() }));

		begin("a", "doc-drift");
		act(() => finishActivity("a", "success"));
		act(() => vi.runAllTimers());

		begin("a", "doc-drift");
		act(() => finishActivity("a", "error", "second time"));
		act(() => vi.runAllTimers());

		expect(toastMock).toHaveBeenCalledTimes(2);
	});
});
