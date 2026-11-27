/** Settings, Approval tiers: the three modes, observe shown when nothing is saved. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { ApprovalTiersSettings } from "../ApprovalTiersSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, string>) =>
			options ? `${key}|${Object.values(options).join("|")}` : key,
	}),
}));

const status = (data: unknown, success = true) => {
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getClaudeShipStatus: vi.fn().mockResolvedValue({ success, data }),
	};
};

afterEach(() => {
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

const base = { theme: "system" } as unknown as AppSettings;

describe("ApprovalTiersSettings", () => {
	it("shows observe when nothing is saved, and the four tiers", () => {
		render(<ApprovalTiersSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("approval-mode-observe")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByTestId("approval-mode-enforce")).toHaveAttribute("aria-pressed", "false");
		for (const tier of ["N0", "N1", "N2", "N3"]) {
			expect(screen.getByText(`sections.approvals.tiers.${tier}.when`)).toBeInTheDocument();
		}
	});

	it("saves the mode with the other settings", () => {
		const change = vi.fn();
		render(<ApprovalTiersSettings settings={base} onSettingsChange={change} />);
		fireEvent.click(screen.getByTestId("approval-mode-enforce"));
		expect(change).toHaveBeenCalledWith({ theme: "system", approvalTiers: "enforce" });
	});

	it("shows an unknown saved value as observe", () => {
		const odd = { ...base, approvalTiers: "always" } as unknown as AppSettings;
		render(<ApprovalTiersSettings settings={odd} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("approval-mode-observe")).toHaveAttribute("aria-pressed", "true");
	});
});

describe("ApprovalTiersSettings, Claude Ship", () => {
	it("is automatic by default and says which accounts were detected", async () => {
		status({ detected: true, accounts: [{ name: "Work", plan: "team" }] });
		render(<ApprovalTiersSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("claude-ship-auto")).toHaveAttribute("aria-pressed", "true");
		await waitFor(() =>
			expect(screen.getByTestId("claude-ship-status").textContent).toContain("Work"),
		);
		expect(screen.getByTestId("claude-ship-active").textContent).toBe(
			"sections.approvals.claudeShip.active",
		);
	});

	it("is not used when nothing was detected, unless forced", async () => {
		status({ detected: false, accounts: [] });
		const change = vi.fn();
		const { rerender } = render(
			<ApprovalTiersSettings settings={base} onSettingsChange={change} />,
		);
		await waitFor(() =>
			expect(screen.getByTestId("claude-ship-status").textContent).toBe(
				"sections.approvals.claudeShip.notDetected",
			),
		);
		expect(screen.getByTestId("claude-ship-active").textContent).toBe(
			"sections.approvals.claudeShip.inactive",
		);
		fireEvent.click(screen.getByTestId("claude-ship-on"));
		expect(change).toHaveBeenCalledWith({ theme: "system", claudeShip: "on" });
		rerender(
			<ApprovalTiersSettings
				settings={{ ...base, claudeShip: "on" } as AppSettings}
				onSettingsChange={change}
			/>,
		);
		expect(screen.getByTestId("claude-ship-active").textContent).toBe(
			"sections.approvals.claudeShip.active",
		);
	});

	it("keeps checking when the main gives no answer", async () => {
		status(undefined, false);
		render(<ApprovalTiersSettings settings={base} onSettingsChange={vi.fn()} />);
		await Promise.resolve();
		expect(screen.getByTestId("claude-ship-status").textContent).toBe(
			"sections.approvals.claudeShip.checking",
		);
	});
});
