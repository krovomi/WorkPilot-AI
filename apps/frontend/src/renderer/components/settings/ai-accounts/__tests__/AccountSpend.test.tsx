/** @vitest-environment jsdom */
/**
 * One AI account's month in Settings → AI accounts: what it spent and its
 * tokens, a budget with how much is used, set or removed in place; an odd
 * amount is refused before it leaves the page.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { AiAccountUsage } from "../../../../../shared/types/ai-account-usage";
import { useAiAccountUsageStore } from "../../../../stores/ai-account-usage-store";
import { AccountSpend } from "../AccountSpend";

const month = (overrides: Partial<AiAccountUsage> = {}): AiAccountUsage => ({
	key: "acc-1",
	costUsd: 8,
	inputTokens: 1_000_000,
	outputTokens: 200_000,
	sessions: 4,
	complete: true,
	budgetUsd: 10,
	level: "warning",
	...overrides,
});

const bridge = {
	getAiAccountUsage: vi.fn(async () => ({
		success: true,
		data: { month: "2026-11", accounts: { "acc-1": month() } },
	})),
	setAiAccountBudget: vi.fn(async (_key: string, amount: number) => ({ success: true, data: amount })),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockClear();
	useAiAccountUsageStore.setState({ month: "2026-11", accounts: { "acc-1": month() }, loaded: true });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("AccountSpend", () => {
	it("shows the month's spend, its tokens and the budget used", () => {
		render(<AccountSpend accountKey="acc-1" />);
		expect(screen.getByText("This month: $8.00 · 1.2M tokens")).toBeInTheDocument();
		expect(screen.getByText("80 % of $10.00 a month")).toBeInTheDocument();
	});

	it("says when the cost is a floor and when the budget is passed", () => {
		useAiAccountUsageStore.setState({
			accounts: { "acc-1": month({ complete: false, costUsd: 12, level: "exceeded" }) },
		});
		render(<AccountSpend accountKey="acc-1" />);
		expect(screen.getByText("(at least)")).toBeInTheDocument();
		expect(screen.getByText("120 % of $10.00 a month")).toHaveClass("text-destructive");
	});

	it("shows an account with nothing recorded and no budget", () => {
		render(<AccountSpend accountKey="claude:new" />);
		expect(screen.getByText("This month: $0.00 · 0 tokens")).toBeInTheDocument();
		expect(screen.getByText("No monthly budget")).toBeInTheDocument();
	});

	it("sets a budget, with a comma or a dot", async () => {
		render(<AccountSpend accountKey="claude:new" />);
		fireEvent.click(screen.getByRole("button", { name: "Set the monthly budget" }));
		const input = screen.getByRole("textbox", { name: "Monthly budget in US dollars" });
		expect(input).toHaveValue("");
		fireEvent.change(input, { target: { value: "12,5" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(bridge.setAiAccountBudget).toHaveBeenCalledWith("claude:new", 12.5));
		await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
	});

	it("starts from the current budget, and an empty field removes it", async () => {
		render(<AccountSpend accountKey="acc-1" />);
		fireEvent.click(screen.getByRole("button", { name: "Set the monthly budget" }));
		const input = screen.getByRole("textbox", { name: "Monthly budget in US dollars" });
		expect(input).toHaveValue("10");
		fireEvent.change(input, { target: { value: "  " } });
		fireEvent.submit(input);
		await waitFor(() => expect(bridge.setAiAccountBudget).toHaveBeenCalledWith("acc-1", 0));
	});

	it("refuses an odd amount on the page and shows a refusal from the app", async () => {
		render(<AccountSpend accountKey="acc-1" />);
		fireEvent.click(screen.getByRole("button", { name: "Set the monthly budget" }));
		const input = screen.getByRole("textbox", { name: "Monthly budget in US dollars" });
		fireEvent.change(input, { target: { value: "-4" } });
		fireEvent.submit(input);
		expect(await screen.findByRole("alert")).toHaveTextContent("Type an amount in dollars");
		fireEvent.change(input, { target: { value: "abc" } });
		fireEvent.submit(input);
		expect(bridge.setAiAccountBudget).not.toHaveBeenCalled();

		bridge.setAiAccountBudget.mockResolvedValueOnce({ success: false, error: "Invalid account" } as never);
		fireEvent.change(input, { target: { value: "5" } });
		fireEvent.submit(input);
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid account");
		expect(screen.getByRole("textbox")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
