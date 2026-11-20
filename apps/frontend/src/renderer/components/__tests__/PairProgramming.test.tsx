/**
 * The pair programming page shows the session of the project it is opened
 * for, and the setup form for a project without one.
 *
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePairProgrammingStore } from "../../stores/pair-programming-store";
import { useProjectStore } from "../../stores/project-store";
import { PairProgramming } from "../PairProgramming";

const getPairSession = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("en");
	Element.prototype.scrollIntoView ??= () => undefined;
	usePairProgrammingStore.getState().reset();
	getPairSession.mockReset().mockImplementation(async (projectId: string) => ({
		success: true,
		data:
			projectId === "p1"
				? { id: "s1", projectId: "p1", goal: "Refactor the parser", status: "active", messages: [], aiActions: [] }
				: null,
	}));
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { getPairSession };
});

describe("the pair programming page", () => {
	it("shows the session of the project on screen, and none of the last project's", async () => {
		useProjectStore.setState({ selectedProjectId: "p1" });
		const { rerender } = render(<PairProgramming projectId="p1" />);
		expect(await screen.findByText("Refactor the parser")).toBeTruthy();
		expect(getPairSession).toHaveBeenCalledWith("p1");

		useProjectStore.setState({ selectedProjectId: "p2" });
		rerender(<PairProgramming projectId="p2" />);
		await vi.waitFor(() => expect(screen.queryByText("Refactor the parser")).toBeNull());
		expect(getPairSession).toHaveBeenLastCalledWith("p2");
		expect(screen.getByText(i18n.t("pairProgramming:setup.goalLabel"))).toBeTruthy();
	});
});
