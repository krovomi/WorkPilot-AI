/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import "../../../shared/i18n";
import type { Task, TaskSplitCheck } from "../../../shared/types";
import { ReviewLoadBadge } from "./SplitPartBadge";

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
