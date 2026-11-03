/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { Tabs } from "../ui/tabs";
import { TaskDetailTab, TaskDetailTabsList } from "./TaskDetailTabs";

describe("TaskDetailTabs", () => {
	it("marks the selected tab with the primary underline and tint", () => {
		render(
			<Tabs defaultValue="overview">
				<TaskDetailTabsList>
					<TaskDetailTab value="overview">Overview</TaskDetailTab>
					<TaskDetailTab value="logs">Logs</TaskDetailTab>
				</TaskDetailTabsList>
			</Tabs>,
		);
		const overview = screen.getByRole("tab", { name: "Overview" });
		const logs = screen.getByRole("tab", { name: "Logs" });
		expect(overview).toHaveAttribute("data-state", "active");
		expect(logs).toHaveAttribute("data-state", "inactive");
		// The styling hangs on data-state, so the same classes serve both tabs.
		expect(overview.className).toContain("data-[state=active]:border-primary");
		expect(overview.className).toContain("data-[state=active]:bg-primary/15");
		expect(overview.className).toContain("border-transparent");

		fireEvent.mouseDown(logs, { button: 0 });
		expect(logs).toHaveAttribute("data-state", "active");
		expect(overview).toHaveAttribute("data-state", "inactive");
	});

	it("scrolls sideways instead of wrapping", () => {
		render(
			<Tabs defaultValue="a">
				<TaskDetailTabsList>
					<TaskDetailTab value="a">A</TaskDetailTab>
				</TaskDetailTabsList>
			</Tabs>,
		);
		const list = screen.getByRole("tablist");
		expect(list).toHaveClass("overflow-x-auto", "border-b");
	});
});
