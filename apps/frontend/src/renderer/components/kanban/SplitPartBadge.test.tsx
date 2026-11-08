/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it } from "vitest";
import "../../../shared/i18n";
import type { Task, TaskSplitCheck } from "../../../shared/types";
import { EMPTY_FILTERS } from "../../lib/kanban-filter";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { ReviewLoadBadge, SplitPartBadge } from "./SplitPartBadge";

const task = (splitCheck?: TaskSplitCheck) => ({ id: "t", metadata: { splitCheck } }) as Task;
const check = (lines: number, files: number): TaskSplitCheck => ({
	lines,
	files,
	maxLines: 400,
	maxFiles: 25,
	kind: "feature",
	over: lines > 400 || files > 25,
});

describe("ReviewLoadBadge", () => {
	it("says how many lines a branch above its ceiling has to review", () => {
		render(<ReviewLoadBadge task={task(check(620, 12))} />);
		const badge = screen.getByText("620 / 400 lines");
		expect(badge.closest("[title]")?.getAttribute("title")).toContain(
			"about 620 lines to review in 12 files",
		);
	});

	it("says the files when only the files pass their ceiling", () => {
		render(<ReviewLoadBadge task={task(check(120, 31))} />);
		expect(screen.getByText("31 / 25 files")).toBeInTheDocument();
	});

	it("shows nothing within the ceiling or before the check", () => {
		const { container, rerender } = render(<ReviewLoadBadge task={task(check(380, 9))} />);
		expect(container).toBeEmptyDOMElement();
		rerender(<ReviewLoadBadge task={task()} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("SplitPartBadge", () => {
	beforeEach(() => {
		useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS } });
	});

	const part = {
		id: "012-oauth-part2",
		specId: "012-oauth-part2",
		metadata: {
			splitGroup: { parent: "012-add-oauth", title: "OAuth Google", index: 2, total: 4, name: "API" },
		},
	} as Task;

	it("writes the part and its group, in the group's tone", () => {
		render(<SplitPartBadge task={part} />);
		const badge = screen.getByRole("button", { name: /Part 2\/4 · OAuth Google/ });
		expect(badge).toHaveClass("wp-scope", "wp-tone-green");
		expect(badge).toHaveAttribute("aria-pressed", "false");
	});

	it("shows only its group on a click, everything on a second one", () => {
		render(<SplitPartBadge task={part} />);
		const badge = screen.getByRole("button");
		fireEvent.click(badge);
		expect(useKanbanFilterStore.getState().filters.group).toBe("012-add-oauth");
		expect(badge).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(badge);
		expect(useKanbanFilterStore.getState().filters.group).toBeUndefined();
	});

	it("colours the split task's badge like its parts, and shows nothing on a whole task", () => {
		const parent = {
			id: "012-add-oauth",
			specId: "012-add-oauth",
			metadata: { splitGroup: { children: ["a", "b"], maxLines: 400 } },
		} as Task;
		const { container, rerender } = render(<SplitPartBadge task={parent} />);
		expect(screen.getByText("Split into 2 tasks").closest(".wp-tone-green")).not.toBeNull();
		rerender(<SplitPartBadge task={{ id: "x", specId: "x", metadata: {} } as Task} />);
		expect(container).toBeEmptyDOMElement();
	});
});
