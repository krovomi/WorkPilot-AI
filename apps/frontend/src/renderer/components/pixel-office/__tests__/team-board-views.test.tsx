import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamBoard } from "../../../../shared/types/pixel-office";
import { TeamBoardPanel } from "../TeamBoardPanel";

const getTeamBoard = vi.fn();
const setTeamConsent = vi.fn();
const api = globalThis as unknown as { electronAPI?: unknown };
const saved = api.electronAPI;

function board(extra: Partial<TeamBoard> = {}): TeamBoard {
	return {
		scope: "project",
		period: "season",
		seasonStart: "2026-10-01T00:00:00+00:00",
		seasonEnd: "2027-01-01T00:00:00+00:00",
		projects: 1,
		entries: [
			{
				rank: 1,
				name: "Ada",
				delivered: 2,
				reviews: 1,
				points: 6,
				badges: ["first_delivery", "first_review"],
				you: false,
			},
			{ rank: 2, name: "Bob", delivered: 1, reviews: 0, points: 1, badges: [], you: true },
		],
		me: {
			visible: true,
			delivered: 1,
			reviews: 0,
			points: 1,
			badges: ["first_delivery"],
			rank: 2,
		},
		...extra,
	};
}

const open = () =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Show the team leaderboard" }));
	});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	getTeamBoard.mockReset();
	setTeamConsent.mockReset();
	api.electronAPI = { pixelOffice: { getTeamBoard, setTeamConsent } };
});

afterEach(() => {
	api.electronAPI = saved;
});

describe("TeamBoardPanel", () => {
	it("reads the board only once opened, and lists the people named", async () => {
		getTeamBoard.mockResolvedValue({ success: true, board: board() });
		render(<TeamBoardPanel projectId="p1" />);
		expect(getTeamBoard).not.toHaveBeenCalled();
		await open();
		await waitFor(() => expect(screen.getAllByTestId("team-board-entry")).toHaveLength(2));
		expect(getTeamBoard).toHaveBeenCalledWith("p1", { scope: "project", period: "season" });
		expect(screen.getByText("Bob (you)")).toBeTruthy();
		expect(screen.getByText("6 pts")).toBeTruthy();
		expect(screen.getByText("1 pt")).toBeTruthy();
		expect(screen.getByRole("img", { name: "First review of a teammate's task" })).toBeTruthy();
		expect(screen.getByTestId("team-board-me").textContent).toContain("First task delivered");
		expect(screen.getByText(/Your name and score show/)).toBeTruthy();
	});

	it("asks again for the organization and since the start", async () => {
		getTeamBoard.mockResolvedValue({ success: true, board: board() });
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Organization" }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Since the start" }));
		});
		expect(getTeamBoard).toHaveBeenLastCalledWith("p1", { scope: "org", period: "all" });
		expect(
			screen.getByRole("button", { name: "Organization" }).getAttribute("aria-pressed"),
		).toBe("true");
	});

	it("says when nobody shows by name and when the person has no badge", async () => {
		getTeamBoard.mockResolvedValue({
			success: true,
			board: board({
				entries: [],
				me: { visible: false, delivered: 0, reviews: 0, points: 0, badges: [], rank: null },
			}),
		});
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		await waitFor(() => expect(screen.getByTestId("team-board-empty")).toBeTruthy());
		expect(screen.getByText(/No badge yet/)).toBeTruthy();
		expect(screen.getByText(/counted for you alone/)).toBeTruthy();
	});

	it("saves the consent, then reads the board again", async () => {
		getTeamBoard.mockResolvedValue({
			success: true,
			board: board({ me: { ...board().me, visible: false } }),
		});
		setTeamConsent.mockResolvedValue({ success: true, visible: true });
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		const toggle = await screen.findByRole("switch", { name: "Show my name to the team" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await act(async () => {
			fireEvent.click(toggle);
		});
		expect(setTeamConsent).toHaveBeenCalledWith("p1", true);
		await waitFor(() => expect(getTeamBoard).toHaveBeenCalledTimes(2));
	});

	it("shows an error when the server refuses or cannot be reached", async () => {
		getTeamBoard.mockResolvedValueOnce({ success: false, error: "Missing permission" });
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		expect(await screen.findByRole("alert")).toBeTruthy();

		getTeamBoard.mockResolvedValue({ success: true, board: board() });
		setTeamConsent.mockResolvedValueOnce({ success: false, error: "nope" });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Organization" }));
		});
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: "Show my name to the team" }));
		});
		expect(await screen.findByRole("alert")).toBeTruthy();

		setTeamConsent.mockRejectedValueOnce(new Error("ipc"));
		getTeamBoard.mockRejectedValueOnce(new Error("ipc"));
		await act(async () => {
			fireEvent.click(screen.getByRole("switch", { name: "Show my name to the team" }));
		});
		expect(await screen.findByRole("alert")).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Since the start" }));
		});
		expect(await screen.findByRole("alert")).toBeTruthy();
	});

	it("shows that it is reading, and drops an answer for a choice since left", async () => {
		let first: (value: unknown) => void = () => undefined;
		getTeamBoard.mockReturnValueOnce(new Promise((resolve) => (first = resolve)));
		getTeamBoard.mockResolvedValue({
			success: true,
			board: board({ entries: [{ ...board().entries[0], name: "Org Ada" }] }),
		});
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		expect(screen.getByText(/Reading the board/)).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Organization" }));
		});
		await waitFor(() => expect(screen.getByText("Org Ada")).toBeTruthy());
		await act(async () => first({ success: true, board: board() }));
		expect(screen.queryByText("Bob (you)")).toBeNull();
	});

	it("shows no board of the project it was read for once another is shown", async () => {
		getTeamBoard.mockResolvedValueOnce({ success: true, board: board() });
		getTeamBoard.mockReturnValue(new Promise(() => undefined));
		const { rerender } = render(<TeamBoardPanel projectId="p1" />);
		await open();
		await waitFor(() => expect(screen.getAllByTestId("team-board-entry")).toHaveLength(2));
		rerender(<TeamBoardPanel projectId="p2" />);
		expect(screen.queryByTestId("team-board-entry")).toBeNull();
		expect(getTeamBoard).toHaveBeenLastCalledWith("p2", { scope: "project", period: "season" });
	});

	it("does nothing without the API", async () => {
		api.electronAPI = {};
		render(<TeamBoardPanel projectId="p1" />);
		await open();
		expect(screen.queryByTestId("team-board-entry")).toBeNull();
	});
});
