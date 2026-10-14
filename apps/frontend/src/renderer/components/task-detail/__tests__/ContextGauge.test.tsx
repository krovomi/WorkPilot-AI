/**
 * @vitest-environment jsdom
 */

/**
 * ContextGauge — the live context-window gauge of a running task.
 *
 * Pinned: nothing without a running task or a reading; the percent and the
 * zone; the popover highlights the backend's recommendation and sends the
 * one-shot request with the task's id; the card's mini ring only while running.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task, TaskContextUsageEvent } from "../../../../shared/types";

vi.mock("../../../hooks/useAgenticCapabilities", () => ({
	useAgenticCapabilities: () => ({ contextCompact: () => null }),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

import { useContextUsageStore } from "../../../stores/context-usage-store";
import { TooltipProvider } from "../../ui/tooltip";
import { ContextGauge, ContextGaugeMini } from "../ContextGauge";

// Radix popper measures its anchor; jsdom has no ResizeObserver.
class ResizeObserverStub {
	observe() {
		/* nothing to measure in jsdom */
	}
	unobserve() {
		/* nothing to measure in jsdom */
	}
	disconnect() {
		/* nothing to measure in jsdom */
	}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??=
	ResizeObserverStub;

const usage: TaskContextUsageEvent = {
	type: "CONTEXT_USAGE",
	phase: "coding",
	subtaskId: "1.1",
	provider: "claude",
	model: "claude-sonnet",
	usedTokens: 124_800,
	windowTokens: 200_000,
	percent: 62.4,
	source: "estimated",
	thresholdPct: 50,
	mode: "auto",
	handoffState: "ready",
	recommended: "clear",
	compactSupport: "native",
};

const makeTask = (status: Task["status"]) =>
	({ id: "t1", specId: "001-x", title: "Task", status, metadata: {} }) as unknown as Task;

const wrap = (node: ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);

const api = globalThis.electronAPI as unknown as Record<string, unknown>;
const requestContextAction = vi.fn();

beforeEach(() => {
	useContextUsageStore.getState().reset();
	requestContextAction.mockReset();
	requestContextAction.mockResolvedValue({ success: true });
	api.requestContextAction = requestContextAction;
});

afterEach(() => {
	delete api.requestContextAction;
});

describe("ContextGauge", () => {
	it("renders nothing for a stopped task without a reading", () => {
		const { container } = wrap(<ContextGauge task={makeTask("human_review")} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a placeholder while running before the first reading", () => {
		wrap(<ContextGauge task={makeTask("in_progress")} />);
		expect(screen.getByTestId("context-gauge")).toHaveTextContent("–");
	});

	it("shows the percent, the zone and the handoff badge", () => {
		useContextUsageStore.getState().applyEvent("t1", usage);
		wrap(<ContextGauge task={makeTask("in_progress")} />);
		const gauge = screen.getByTestId("context-gauge");
		expect(gauge).toHaveTextContent("62%");
		expect(gauge).toHaveTextContent("tasks:contextManagement.handoff.ready");
		// Above the 50% threshold: red zone.
		expect(screen.getByText("62%")).toHaveClass("text-destructive");
		expect(screen.getAllByTestId("progress-ring-marker")).toHaveLength(1);
	});

	it("highlights the recommendation and sends the request", async () => {
		useContextUsageStore.getState().applyEvent("t1", usage);
		wrap(<ContextGauge task={makeTask("in_progress")} />);
		fireEvent.click(screen.getByTestId("context-gauge"));

		const clear = await screen.findByTestId("context-action-clear");
		const compact = screen.getByTestId("context-action-compact");
		expect(clear).toHaveAttribute("data-recommended", "true");
		expect(compact).not.toHaveAttribute("data-recommended");

		await act(async () => {
			fireEvent.click(compact);
		});
		expect(requestContextAction).toHaveBeenCalledWith("t1", "compact");
		await waitFor(() =>
			expect(useContextUsageStore.getState().pending.t1).toBe("compact"),
		);
		expect(screen.getByTestId("context-action-clear")).toBeDisabled();
	});

	it("releases the buttons and shows the error when the request fails", async () => {
		requestContextAction.mockResolvedValue({ success: false, error: "Task is not running" });
		useContextUsageStore.getState().applyEvent("t1", usage);
		wrap(<ContextGauge task={makeTask("in_progress")} />);
		fireEvent.click(screen.getByTestId("context-gauge"));
		await act(async () => {
			fireEvent.click(await screen.findByTestId("context-action-clear"));
		});
		expect(await screen.findByRole("alert")).toHaveTextContent("Task is not running");
		expect(useContextUsageStore.getState().pending.t1).toBeUndefined();
	});
});

describe("ContextGaugeMini", () => {
	it("shows only while running with a reading", () => {
		const { container, rerender } = wrap(<ContextGaugeMini task={makeTask("in_progress")} />);
		expect(container).toBeEmptyDOMElement();

		act(() => useContextUsageStore.getState().applyEvent("t1", usage));
		rerender(
			<TooltipProvider>
				<ContextGaugeMini task={makeTask("in_progress")} />
			</TooltipProvider>,
		);
		expect(screen.getByTestId("context-gauge-mini")).toHaveTextContent("62%");

		rerender(
			<TooltipProvider>
				<ContextGaugeMini task={makeTask("done")} />
			</TooltipProvider>,
		);
		expect(screen.queryByTestId("context-gauge-mini")).not.toBeInTheDocument();
	});
});
