/**
 * The compaction pill of a long task: progress at a glance, and a summary of the
 * steps that matter, in the app's language.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { ExecutionPhase, Subtask, SubtaskStatus, Task } from "../../../shared/types";
import { SessionCompactionBadge } from "../SessionCompactionBadge";

function subtask(index: number, status: SubtaskStatus, patch: Partial<Subtask> = {}): Subtask {
	return {
		id: `s${index}`,
		title: `Step ${index}`,
		description: "",
		status,
		files: [],
		...patch,
	};
}

function task(subtasks: Subtask[], phase?: ExecutionPhase): Task {
	return {
		id: "t1",
		specId: "001",
		projectId: "p1",
		title: "Long task",
		description: "",
		status: "in_progress",
		subtasks,
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...(phase
			? { executionProgress: { phase, phaseProgress: 0, overallProgress: 0 } }
			: {}),
	} as Task;
}

/** Twelve steps, half done, one of them a review still running. */
function cleanRun(): Subtask[] {
	return Array.from({ length: 12 }, (_, i) => {
		if (i < 6) return subtask(i + 1, "completed");
		if (i === 6) return subtask(7, "in_progress", { title: "Review the API" });
		return subtask(i + 1, "pending");
	});
}

/** Clicks that would reach the task card around the badge (React bubbling, portals included). */
const parentClick = vi.fn();

function renderBadge(t: Task) {
	return render(
		createElement("div", { onClick: parentClick }, <SessionCompactionBadge task={t} />),
	);
}

describe("SessionCompactionBadge", () => {
	beforeEach(async () => {
		parentClick.mockClear();
		await i18n.changeLanguage("en");
	});

	afterEach(async () => {
		await act(() => i18n.changeLanguage("en"));
	});

	it("shows nothing for a short task", () => {
		const { container } = renderBadge(
			task(Array.from({ length: 9 }, (_, i) => subtask(i + 1, "completed"))),
		);
		expect(container.firstElementChild?.childElementCount).toBe(0);
	});

	it("opens a summary of a clean run without opening the card", () => {
		renderBadge(task(cleanRun(), "qa_review"));
		const trigger = screen.getByRole("button", { name: /12 phases/ });
		expect(trigger.getAttribute("title")).toBe(
			"12 execution phases — click to see the compacted summary",
		);
		expect(trigger.textContent).toContain("50%");

		fireEvent.click(trigger);
		expect(parentClick).not.toHaveBeenCalled();

		expect(screen.getByText("Session Compaction")).toBeTruthy();
		expect(screen.getByText("6/12")).toBeTruthy();
		expect(screen.getByText("6/12 phases completed, no failures.")).toBeTruthy();
		expect(screen.getByText(/Key steps/).textContent).toBe("Key steps · 3/12");
		// First, the review, and the last step are kept.
		expect(screen.getByText("Step 1")).toBeTruthy();
		expect(screen.getByText("Review the API")).toBeTruthy();
		expect(screen.getByText("Step 12")).toBeTruthy();
		expect(screen.queryByText("Step 5")).toBeNull();

		expect(screen.getByText("Current phase:")).toBeTruthy();
		expect(screen.getByText("Reviewing")).toBeTruthy();
		expect(screen.queryByText("qa_review")).toBeNull();

		// A click inside the summary does not reach the card either.
		fireEvent.click(screen.getByText("Session Compaction"));
		expect(parentClick).not.toHaveBeenCalled();
	});

	it("leads with the last failure and why it failed", () => {
		const steps = cleanRun();
		steps[2] = subtask(3, "failed", { title: "Wire the form" });
		steps[8] = subtask(9, "blocked", {
			title: "Migrate the schema",
			blockedReason: "Failed after 5 attempts",
		});
		renderBadge(task(steps, "coding"));
		fireEvent.click(screen.getByRole("button", { name: /12 phases/ }));

		expect(
			screen.getByText(
				"5/12 phases completed, 2 need attention. Last issue at phase 9: Migrate the schema",
			),
		).toBeTruthy();
		expect(screen.getByText("Failed after 5 attempts")).toBeTruthy();
		expect(screen.getByText("Last error:")).toBeTruthy();
		expect(screen.getByText("#9 Migrate the schema")).toBeTruthy();
		// The failure wins over the current phase.
		expect(screen.queryByText("Current phase:")).toBeNull();
	});

	it("words a single failure in the singular", () => {
		const steps = cleanRun();
		steps[11] = subtask(12, "failed");
		renderBadge(task(steps));
		fireEvent.click(screen.getByRole("button", { name: /12 phases/ }));
		expect(
			screen.getByText(
				"6/12 phases completed, 1 needs attention. Last issue at phase 12: Step 12",
			),
		).toBeTruthy();
	});

	it("has no footer when nothing runs and nothing failed", () => {
		renderBadge(task(cleanRun()));
		fireEvent.click(screen.getByRole("button", { name: /12 phases/ }));
		expect(screen.getByText("6/12 phases completed, no failures.")).toBeTruthy();
		expect(screen.queryByText("Current phase:")).toBeNull();
		expect(screen.queryByText("Last error:")).toBeNull();
	});

	it("speaks French in French", async () => {
		await act(() => i18n.changeLanguage("fr"));
		const steps = cleanRun();
		steps[8] = subtask(9, "blocked", { title: "Migrate the schema" });
		renderBadge(task(steps, "planning"));
		fireEvent.click(screen.getByRole("button", { name: /12 phases/ }));
		expect(
			screen.getByText(
				"6/12 phases terminées, 1 à revoir. Dernier problème à la phase 9 : Migrate the schema",
			),
		).toBeTruthy();
		expect(screen.getByText("Compaction de session")).toBeTruthy();
	});

	it("names the current phase in French", async () => {
		await act(() => i18n.changeLanguage("fr"));
		renderBadge(task(cleanRun(), "qa_fixing"));
		fireEvent.click(screen.getByRole("button", { name: /12 phases/ }));
		expect(screen.getByText("6/12 phases terminées, aucun échec.")).toBeTruthy();
		expect(screen.getByText("Phase actuelle:")).toBeTruthy();
		expect(screen.getByText("Correction")).toBeTruthy();
	});
});
