/**
 * @vitest-environment jsdom
 */
/**
 * The page shown while no project is open: what WorkPilot does, and the way
 * to add a project.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";

// The setup banner reads the whole setup status; it has its own tests.
vi.mock("../setup-hub/SetupBanner", () => ({
	SetupBanner: () => <div data-testid="setup-banner" />,
}));

import { NoProjectPage } from "../NoProjectPage";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("NoProjectPage", () => {
	it("says what WorkPilot does and nudges to finish the setup", () => {
		render(<NoProjectPage onAddProject={vi.fn()} />);
		expect(screen.getByTestId("setup-banner")).toBeInTheDocument();
		expect(screen.getByText("Welcome to WorkPilot AI!")).toBeInTheDocument();
		expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
			"Isolated git worktrees keep your main branch safe",
			"Parallel AI agents plan, build and review your code",
			"Full task history, QA validation and PR creation",
		]);
	});

	it("adds a new or an existing project", () => {
		const onAddProject = vi.fn();
		render(<NoProjectPage onAddProject={onAddProject} />);
		fireEvent.click(screen.getByRole("button", { name: "New project" }));
		fireEvent.click(screen.getByRole("button", { name: "Open existing project" }));
		expect(onAddProject).toHaveBeenCalledTimes(2);
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		render(<NoProjectPage onAddProject={vi.fn()} />);
		expect(screen.getByRole("button", { name: "Ouvrir un projet existant" })).toBeInTheDocument();
	});
});
