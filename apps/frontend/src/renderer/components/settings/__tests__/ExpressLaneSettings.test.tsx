/** Settings, Approval tiers, Express lane: off by default, and said to wait for enforce. */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/types";
import { ApprovalTiersSettings } from "../ApprovalTiersSettings";
import { ExpressLaneSettings } from "../ExpressLaneSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const base = { theme: "system" } as unknown as AppSettings;

describe("ExpressLaneSettings", () => {
	it("is off when nothing is saved, and shown at the end of the approval tiers", () => {
		render(<ApprovalTiersSettings settings={base} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("express-lane-toggle")).toHaveAttribute("aria-checked", "false");
		expect(screen.getByText("sections.approvals.express.title")).toBeInTheDocument();
		expect(screen.queryByTestId("express-lane-needs-enforce")).toBeNull();
	});

	it("saves the switch with the other settings", () => {
		const change = vi.fn();
		render(<ExpressLaneSettings settings={base} onSettingsChange={change} />);
		fireEvent.click(screen.getByTestId("express-lane-toggle"));
		expect(change).toHaveBeenCalledWith({ theme: "system", expressLane: true });
	});

	it("says it waits for enforce when it is on and the tiers only observe", () => {
		const on = { ...base, expressLane: true } as AppSettings;
		const { rerender } = render(<ExpressLaneSettings settings={on} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("express-lane-toggle")).toHaveAttribute("aria-checked", "true");
		expect(screen.getByTestId("express-lane-needs-enforce")).toBeInTheDocument();
		rerender(
			<ExpressLaneSettings
				settings={{ ...on, approvalTiers: "enforce" }}
				onSettingsChange={vi.fn()}
			/>,
		);
		expect(screen.queryByTestId("express-lane-needs-enforce")).toBeNull();
	});

	it("reads only a true boolean as on", () => {
		const odd = { ...base, expressLane: "yes" } as unknown as AppSettings;
		render(<ExpressLaneSettings settings={odd} onSettingsChange={vi.fn()} />);
		expect(screen.getByTestId("express-lane-toggle")).toHaveAttribute("aria-checked", "false");
	});
});
