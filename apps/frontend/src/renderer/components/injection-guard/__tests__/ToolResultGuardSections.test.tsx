/**
 * Flagged tool results and trusted sources on the Injection Guard page (#388).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" },
	}),
}));

import { ToolResultGuardSections } from "../ToolResultGuardSections";

const getToolResultAlerts = vi.fn();
const getTrustedSources = vi.fn();
const setTrustedSources = vi.fn();

beforeEach(() => {
	getToolResultAlerts.mockReset();
	getTrustedSources.mockReset();
	setTrustedSources.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getToolResultAlerts,
		getTrustedSources,
		setTrustedSources,
	};
});

describe("ToolResultGuardSections", () => {
	it("lists the flagged results with their source and finding", async () => {
		getToolResultAlerts.mockResolvedValue([
			{
				spec: "001-a",
				at: "2026-11-09T10:00:00+00:00",
				tool: "WebFetch",
				source: "host:evil.example",
				level: "blocked",
				findings: ["Direct instruction override attempt"],
				action: "withheld",
			},
		]);
		getTrustedSources.mockResolvedValue([]);
		render(<ToolResultGuardSections projectPath="/repo" />);
		expect(await screen.findByText("host:evil.example")).toBeInTheDocument();
		expect(screen.getByText("Direct instruction override attempt")).toBeInTheDocument();
		expect(getToolResultAlerts).toHaveBeenCalledWith("/repo");
	});

	it("says when nothing was flagged", async () => {
		getToolResultAlerts.mockResolvedValue([]);
		getTrustedSources.mockResolvedValue([]);
		render(<ToolResultGuardSections projectPath="/repo" />);
		expect(await screen.findByTestId("tool-result-alerts-empty")).toBeInTheDocument();
	});

	it("adds and removes a trusted source through main", async () => {
		getToolResultAlerts.mockResolvedValue([]);
		getTrustedSources.mockResolvedValue(["host:docs.python.org"]);
		setTrustedSources.mockImplementation(async (_p: string, s: string[]) => s);
		const user = userEvent.setup();
		render(<ToolResultGuardSections projectPath="/repo" />);
		expect(await screen.findByText("host:docs.python.org")).toBeInTheDocument();

		await user.type(screen.getByLabelText("trusted.patternLabel"), "tests/fixtures/*{Enter}");
		await waitFor(() =>
			expect(setTrustedSources).toHaveBeenCalledWith("/repo", [
				"host:docs.python.org",
				"path:tests/fixtures/*",
			]),
		);
		expect(await screen.findByText("path:tests/fixtures/*")).toBeInTheDocument();

		await user.click(screen.getAllByLabelText("trusted.remove")[0]);
		await waitFor(() =>
			expect(setTrustedSources).toHaveBeenLastCalledWith("/repo", ["path:tests/fixtures/*"]),
		);
	});

	it("says when main refused the entry", async () => {
		getToolResultAlerts.mockResolvedValue([]);
		getTrustedSources.mockResolvedValue([]);
		setTrustedSources.mockResolvedValue([]);
		const user = userEvent.setup();
		render(<ToolResultGuardSections projectPath="/repo" />);
		await user.type(await screen.findByLabelText("trusted.patternLabel"), "*{Enter}");
		expect(await screen.findByText("trusted.invalid")).toBeInTheDocument();
	});
});
