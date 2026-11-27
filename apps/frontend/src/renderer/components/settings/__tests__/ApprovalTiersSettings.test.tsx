/** Settings, Approval tiers: the three modes, observe shown when nothing is saved. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { ApprovalTiersSettings } from "../ApprovalTiersSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

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
