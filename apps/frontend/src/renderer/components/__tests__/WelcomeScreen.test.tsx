/**
 * The welcome screen: start or open a project, or pick one of the ten most recent.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { Project } from "../../../shared/types";
import { WelcomeScreen } from "../WelcomeScreen";

const NOW = new Date("2026-11-20T12:00:00Z");

function project(id: string, updatedAt: Date, patch: Partial<Project> = {}): Project {
	return {
		id,
		name: `Project ${id}`,
		path: `/work/${id}`,
		autoBuildPath: "",
		settings: {} as Project["settings"],
		createdAt: updatedAt,
		updatedAt,
		...patch,
	};
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function renderScreen(projects: Project[]) {
	const handlers = {
		onNewProject: vi.fn(),
		onOpenProject: vi.fn(),
		onSelectProject: vi.fn(),
	};
	render(<WelcomeScreen projects={projects} {...handlers} />);
	return handlers;
}

describe("WelcomeScreen", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		await i18n.changeLanguage("en");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await act(() => i18n.changeLanguage("en"));
	});

	it("offers to create or open a project, and explains the empty list", () => {
		const { onNewProject, onOpenProject } = renderScreen([]);

		expect(screen.getByRole("heading", { name: "Welcome to WorkPilot AI" })).toBeTruthy();
		expect(screen.getByText("No projects yet")).toBeTruthy();
		expect(
			screen.getByText("Create a new project or open an existing one to get started"),
		).toBeTruthy();
		expect(screen.queryByText("Recent Projects")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "New Project" }));
		fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
		expect(onNewProject).toHaveBeenCalledOnce();
		expect(onOpenProject).toHaveBeenCalledOnce();
	});

	it("lists the most recent projects first with how long ago they changed", () => {
		const { onSelectProject } = renderScreen([
			project("old", new Date("2026-10-02T12:00:00Z")),
			project("now", ago(10_000), { autoBuildPath: "/work/now/.workpilot" }),
			project("mins", ago(5 * MIN)),
			project("hours", ago(3 * HOUR)),
			project("days", ago(2 * DAY)),
		]);

		expect(screen.getByText("Recent Projects")).toBeTruthy();
		expect(screen.queryByText("No projects yet")).toBeNull();

		const rows = screen.getAllByRole("button", { name: /^Open project / });
		expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
			"Open project Project now",
			"Open project Project mins",
			"Open project Project hours",
			"Open project Project days",
			"Open project Project old",
		]);
		expect(within(rows[0]).getByText("just now")).toBeTruthy();
		expect(within(rows[0]).getByText("Initialized")).toBeTruthy();
		expect(within(rows[0]).getByText("/work/now")).toBeTruthy();
		expect(within(rows[1]).getByText("5m ago")).toBeTruthy();
		expect(within(rows[1]).queryByText("Initialized")).toBeNull();
		expect(within(rows[2]).getByText("3h ago")).toBeTruthy();
		expect(within(rows[3]).getByText("2d ago")).toBeTruthy();
		expect(within(rows[4]).getByText("10/2/2026")).toBeTruthy();

		fireEvent.click(rows[2]);
		expect(onSelectProject).toHaveBeenCalledWith("hours");
	});

	it("writes an old date the French way in French", async () => {
		await act(() => i18n.changeLanguage("fr"));
		renderScreen([project("old", new Date("2026-10-02T12:00:00Z"))]);
		expect(screen.getByText("02/10/2026")).toBeTruthy();
	});

	it("keeps only the ten most recent", () => {
		renderScreen(
			Array.from({ length: 12 }, (_, i) => project(`p${i}`, ago((i + 1) * MIN))),
		);
		const rows = screen.getAllByRole("button", { name: /^Open project / });
		expect(rows).toHaveLength(10);
		expect(screen.queryByText("Project p10")).toBeNull();
		expect(screen.queryByText("Project p11")).toBeNull();
	});
});
