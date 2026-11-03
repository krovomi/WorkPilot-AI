/**
 * @vitest-environment jsdom
 */
/**
 * Log search: previous/next navigation over the visible hits, the "n/N"
 * counter, the case / whole word / regex options and the phase / type filters.
 */

import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task, TaskLogs as TaskLogsType } from "../../../shared/types";
import { TaskLogs } from "./TaskLogs";

beforeEach(() => {
	HTMLElement.prototype.scrollTo = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* Layout is simulated in jsdom. */
			}
			disconnect() {
				/* No browser observation to release. */
			}
		},
	);
});

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		// Keys come back with their interpolation values, so "1/3" is readable.
		t: (key: string, a?: unknown, b?: unknown) => {
			const opts = (typeof a === "object" ? a : b) as
				| Record<string, unknown>
				| undefined;
			if (key === "tasks:logs.search.position" && opts) {
				return `${opts.current}/${opts.total}`;
			}
			return opts && "count" in opts ? `${key}:${opts.count}` : key;
		},
		i18n: { language: "en" },
	}),
}));

vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: (selector: (s: unknown) => unknown) =>
		selector({ settings: {}, profiles: [] }),
}));

vi.mock("../../stores/task-store", () => ({
	persistUpdateTask: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({ models: [] }),
}));

vi.mock("../../../shared/utils/providers", () => ({
	getStaticProviders: vi.fn().mockResolvedValue({ providers: [], status: {} }),
}));

function entry(phase: string, type: string, content: string, ts: number) {
	return {
		timestamp: `2026-10-10T12:00:${String(ts).padStart(2, "0")}Z`,
		type,
		content,
		phase,
	};
}

function sampleLogs(): TaskLogsType {
	return {
		phases: {
			planning: {
				status: "completed",
				entries: [
					entry("planning", "text", "Reading the build config", 1),
					entry("planning", "error", "Build step failed", 2),
				],
			},
			coding: {
				status: "completed",
				entries: [
					entry("coding", "text", "Fixing the build", 3),
					entry("coding", "text", "Rebuilding everything", 4),
				],
			},
			validation: { status: "pending", entries: [] },
		},
	} as unknown as TaskLogsType;
}

function renderLogs() {
	const containerRef = createRef<HTMLDivElement>();
	render(
		<TaskLogs
			task={{ id: "task-1", metadata: {} } as unknown as Task}
			phaseLogs={sampleLogs()}
			isLoadingLogs={false}
			expandedPhases={new Set()}
			isStuck={false}
			logsEndRef={createRef<HTMLDivElement>()}
			logsContainerRef={containerRef}
			onLogsScroll={vi.fn()}
			onTogglePhase={vi.fn()}
		/>,
	);
	const input = screen.getByLabelText("tasks:logs.search.ariaLabel");
	return { containerRef, input };
}

/** A chip of the filter panel (phase names also title the log sections). */
function chip(group: "filterPhase" | "filterKind", label: string) {
	const fieldset = screen.getByRole("group", {
		name: `tasks:logs.search.${group}`,
	});
	return within(fieldset).getByText(label);
}

function activeText(container: HTMLElement | null): string | undefined {
	return container
		?.querySelector("[data-active-match]")
		?.textContent?.replace(/\s+/g, " ")
		.trim();
}

function matchCount(container: HTMLElement | null): number {
	return container?.querySelectorAll("[data-log-match]").length ?? 0;
}

describe("TaskLogs — search navigation", () => {
	it("selects the first hit, then moves with Enter / Shift+Enter and wraps", () => {
		const { containerRef, input } = renderLogs();
		fireEvent.change(input, { target: { value: "build" } });

		// "Rebuilding" contains "build" too: 4 hits across two phases.
		expect(matchCount(containerRef.current)).toBe(4);
		expect(screen.getByText("1/4")).toBeInTheDocument();
		expect(activeText(containerRef.current)).toContain("Reading the build config");
		expect(containerRef.current?.scrollTo).toHaveBeenCalled();

		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.getByText("2/4")).toBeInTheDocument();
		expect(activeText(containerRef.current)).toContain("Build step failed");

		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(screen.getByText("4/4")).toBeInTheDocument();
		expect(activeText(containerRef.current)).toContain("Rebuilding everything");

		fireEvent.click(screen.getByLabelText("tasks:logs.search.next"));
		expect(screen.getByText("1/4")).toBeInTheDocument();
	});

	it("narrows with whole word and case options", () => {
		const { containerRef, input } = renderLogs();
		fireEvent.change(input, { target: { value: "build" } });

		fireEvent.click(screen.getByLabelText("tasks:logs.search.wholeWord"));
		expect(matchCount(containerRef.current)).toBe(3);

		fireEvent.click(screen.getByLabelText("tasks:logs.search.caseSensitive"));
		// "Build step failed" starts with a capital B.
		expect(matchCount(containerRef.current)).toBe(2);
		expect(
			screen.getByLabelText("tasks:logs.search.caseSensitive"),
		).toHaveAttribute("aria-pressed", "true");
	});

	it("says so when the regular expression does not compile", () => {
		const { containerRef, input } = renderLogs();
		fireEvent.click(screen.getByLabelText("tasks:logs.search.regex"));
		fireEvent.change(input, { target: { value: "build(" } });

		expect(screen.getByText("tasks:logs.search.invalidRegex")).toBeInTheDocument();
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(matchCount(containerRef.current)).toBe(0);

		fireEvent.change(input, { target: { value: "\\bbuild\\b" } });
		expect(matchCount(containerRef.current)).toBe(3);
	});

	it("filters by entry type and by phase without a query", () => {
		const { containerRef } = renderLogs();
		fireEvent.click(screen.getByLabelText("tasks:logs.search.filters"));

		fireEvent.click(chip("filterKind", "tasks:logs.search.kinds.text"));
		// Only the error entry is left; no hit is selected before navigating.
		expect(matchCount(containerRef.current)).toBe(1);
		expect(screen.getByText("tasks:logs.search.entries:1")).toBeInTheDocument();
		expect(containerRef.current?.querySelector("[data-active-match]")).toBeNull();

		fireEvent.click(screen.getByText("tasks:logs.search.resetFilters"));
		fireEvent.click(chip("filterPhase", "tasks:execution.phases.planning"));
		expect(
			containerRef.current?.querySelector('[data-phase-section="planning"]'),
		).toBeNull();
		expect(matchCount(containerRef.current)).toBe(2);

		fireEvent.click(screen.getByLabelText("tasks:logs.search.next"));
		expect(activeText(containerRef.current)).toContain("Fixing the build");
	});

	it("keeps the last selected value of a filter on", () => {
		const { containerRef } = renderLogs();
		fireEvent.click(screen.getByLabelText("tasks:logs.search.filters"));
		fireEvent.click(chip("filterPhase", "tasks:execution.phases.planning"));
		fireEvent.click(chip("filterPhase", "tasks:execution.phases.validation"));
		fireEvent.click(chip("filterPhase", "tasks:execution.phases.coding"));

		expect(
			chip("filterPhase", "tasks:execution.phases.coding"),
		).toHaveAttribute("aria-pressed", "true");
		expect(matchCount(containerRef.current)).toBe(2);
	});

	it("clears the query with Escape", () => {
		const { containerRef, input } = renderLogs();
		fireEvent.change(input, { target: { value: "build" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(input).toHaveValue("");
		expect(matchCount(containerRef.current)).toBe(0);
	});
});
