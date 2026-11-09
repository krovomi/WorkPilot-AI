/**
 * The banner tells where generated code went (a card on its own branch) and
 * opens the pull request from the card, with the real catalogue so a missing
 * key fails here.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { GeneratedReview } from "../../../../shared/types/generated-review";
import { GeneratedReviewBanner } from "../GeneratedReviewBanner";

const { loadTasksMock } = vi.hoisted(() => ({ loadTasksMock: vi.fn() }));
vi.mock("../../../stores/task-store", () => ({
	loadTasks: (...args: unknown[]) => loadTasksMock(...args),
}));

const review: GeneratedReview = {
	taskId: "012-tests",
	specId: "012-tests",
	title: "Tests générés : Program.cs",
	branch: "workpilot/012-tests",
	baseBranch: "develop",
	files: ["tests/ProgramTests.cs", "tests/Tests.csproj"],
	committed: true,
	reused: false,
};

const createWorktreePR = vi.fn();
const openExternal = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("fr");
	loadTasksMock.mockReset().mockResolvedValue(undefined);
	createWorktreePR.mockReset();
	openExternal.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		createWorktreePR,
		openExternal,
	};
});

describe("GeneratedReviewBanner", () => {
	it("says the code is on the card's branch, not in the project folder", () => {
		render(<GeneratedReviewBanner review={review} projectId="p1" />);

		expect(screen.getByText(/pas dans votre dossier de projet/)).toBeInTheDocument();
		expect(
			screen.getByText(/2 fichiers commités sur workpilot\/012-tests .* vers develop/),
		).toBeInTheDocument();
	});

	it("closes its dialog and opens the card on the board after reloading it", async () => {
		const navigate = vi.fn();
		const onOpenCard = vi.fn();
		globalThis.addEventListener("workpilot:navigate-view", navigate);
		render(<GeneratedReviewBanner review={review} projectId="p1" onOpenCard={onOpenCard} />);

		fireEvent.click(screen.getByRole("button", { name: /Voir la carte/ }));

		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(loadTasksMock).toHaveBeenCalledWith("p1", { forceRefresh: true });
		expect(onOpenCard).toHaveBeenCalled();
		expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
			view: "kanban",
			taskId: "012-tests",
		});
		globalThis.removeEventListener("workpilot:navigate-view", navigate);
	});

	it("creates the pull request from the card and links to it", async () => {
		createWorktreePR.mockResolvedValue({
			success: true,
			data: { success: true, prUrl: "https://github.com/o/r/pull/9" },
		});
		render(<GeneratedReviewBanner review={review} projectId="p1" />);

		fireEvent.click(screen.getByRole("button", { name: /Créer la PR/ }));
		fireEvent.click(await screen.findByRole("button", { name: /Ouvrir la PR/ }));

		expect(createWorktreePR).toHaveBeenCalledWith("012-tests", {
			title: "Tests générés : Program.cs",
		});
		expect(openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/9");
	});

	it("shows why the pull request was not created", async () => {
		createWorktreePR.mockResolvedValue({
			success: true,
			data: { success: false, error: "gh: not logged in" },
		});
		render(<GeneratedReviewBanner review={review} projectId="p1" />);

		fireEvent.click(screen.getByRole("button", { name: /Créer la PR/ }));

		expect(await screen.findByRole("alert")).toHaveTextContent("gh: not logged in");
	});
});
