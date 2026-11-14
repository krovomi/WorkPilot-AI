/**
 * @vitest-environment jsdom
 */
/** The Costs page's budget (#355): where it stands and what the backend enforces. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../../shared/i18n";

vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import type { CostBudgetStatus } from "../../../../shared/types/cost-budget";
import { CostBudgetSection } from "../CostBudgetSection";

const config = {
	limit: 0,
	period: "monthly" as const,
	warning_threshold: 0.75,
	critical_threshold: 0.9,
	task_limit: 0,
	on_exceed: "pause" as const,
	degrade: false,
	stall_multiplier: 3,
};

function status(over: Partial<CostBudgetStatus> = {}): CostBudgetStatus {
	return {
		config,
		configured: false,
		spent: 0,
		complete: true,
		remaining: 0,
		utilizationPct: 0,
		level: "ok",
		forecastEndOfPeriod: 0,
		tasksOverWarning: [],
		...over,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("CostBudgetSection", () => {
	it("saves what the person typed, as numbers", async () => {
		const setCostBudget = vi.fn().mockResolvedValue({ success: true });
		vi.stubGlobal("electronAPI", { setCostBudget });
		const onSaved = vi.fn();
		render(<CostBudgetSection projectPath="/p" status={status()} onSaved={onSaved} />);
		expect(screen.getByText("No budget")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Project budget"), { target: { value: "50" } });
		fireEvent.change(screen.getByLabelText("Limit per task"), { target: { value: "5" } });
		fireEvent.click(screen.getByRole("switch", { name: /lighter model/i }));
		fireEvent.click(screen.getByRole("button", { name: /save the budget/i }));
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(setCostBudget).toHaveBeenCalledWith("/p", {
			...config,
			limit: 50,
			task_limit: 5,
			degrade: true,
		});
	});

	it("shows where a set budget stands and what happens at its limit", () => {
		render(
			<CostBudgetSection
				projectPath="/p"
				status={status({
					config: { ...config, limit: 10, task_limit: 4 },
					configured: true,
					spent: 9.5,
					complete: false,
					utilizationPct: 95,
					level: "critical",
					tasksOverWarning: [{ specId: "001-a", spent: 4.5 }],
				})}
				onSaved={vi.fn()}
			/>,
		);
		expect(screen.getByText(/95%: critical/)).toBeInTheDocument();
		expect(screen.getByText(/at least \$9\.50 spent/)).toBeInTheDocument();
		expect(screen.getByText(/the limit is close/)).toHaveTextContent(/paused before their next session/);
		expect(screen.getByText(/001-a/)).toBeInTheDocument();
	});
});
