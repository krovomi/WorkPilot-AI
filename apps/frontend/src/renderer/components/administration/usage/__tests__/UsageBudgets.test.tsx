/** @vitest-environment jsdom */
/**
 * The budgets pane: the organization's own budget, each budget with this
 * month's use, one set for a member, a group or a project and one removed,
 * an amount the server would refuse never sent, the last alerts, and
 * read-only without `usage.write`.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { UsageBudgets as Budgets } from "@shared/types/server-usage";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { tokensOf, UsageBudgets } from "../UsageBudgets";

const BUDGETS: Budgets = {
	organization: {
		id: null,
		scope: "org",
		target_id: null,
		name: null,
		monthly_tokens: 10_000_000,
		block: false,
		used: 2_500_000,
		percent: 25,
	},
	budgets: [
		{ id: "b1", scope: "person", target_id: "u1", name: "Ada", monthly_tokens: 1_000_000, block: true, used: 1_200_000, percent: 120 },
		{ id: "b2", scope: "group", target_id: "g1", name: "Team A", monthly_tokens: 2_000_000, block: false, used: 1_700_000, percent: 85 },
		{ id: "b3", scope: "project", target_id: "p1", name: null, monthly_tokens: 500_000, block: false, used: 0, percent: 0 },
		{ id: "b4", scope: "team", target_id: null, name: "Odd", monthly_tokens: 1, block: false, used: 0, percent: 0 },
	],
	alerts: [
		{ budget_id: "b1", scope: "person", month: "2026-11-01", threshold: 100, percent: 120, recipients: 2 },
		{ budget_id: null, scope: "org", month: "2026-11-01", threshold: 80, percent: 81, recipients: 1 },
		{ budget_id: "gone", scope: "group", month: "2026-10-01", threshold: 80, percent: 90, recipients: 3 },
	],
};

const serverUsage = { getBudgets: vi.fn(), setBudget: vi.fn(), removeBudget: vi.fn() };

function grant(...permissions: string[]): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: false,
		orgId: "o1",
		organizations: [],
		permissions: new Set(permissions),
	});
}

beforeEach(() => {
	for (const fn of Object.values(serverUsage)) fn.mockReset();
	serverUsage.getBudgets.mockResolvedValue({ ok: true, data: BUDGETS });
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
	useAdminStore.setState({
		members: [
			{ user_id: "u1", email: "ada@example.com", display_name: "Ada", role_id: "r", role_slug: "member", role_name: "Member", is_active: true, created_at: "" },
			{ user_id: "u2", email: "bob@example.com", display_name: "", role_id: "r", role_slug: "member", role_name: "Member", is_active: true, created_at: "" },
		],
		groups: [{ id: "g1", name: "Team A", description: "", role_slug: null, role_name: null, members: [], projects: [], created_at: "" }],
		groupProjects: [{ id: "p1", name: "Shop" }],
		loadMembers: vi.fn(async () => undefined),
		loadGroups: vi.fn(async () => undefined),
		loadGroupProjects: vi.fn(async () => undefined),
	});
	grant("usage.read", "usage.write");
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

function section(title: string): HTMLElement {
	return screen.getByText(title, { selector: "h3" }).closest("section") as HTMLElement;
}

describe("tokensOf", () => {
	it("reads a whole number of tokens, with or without separators", () => {
		expect(tokensOf("2000000")).toBe(2_000_000);
		expect(tokensOf("2 000 000")).toBe(2_000_000);
		expect(tokensOf("2,000,000")).toBe(2_000_000);
		expect(tokensOf("")).toBeNull();
		expect(tokensOf("0")).toBeNull();
		expect(tokensOf("ten")).toBeNull();
		expect(tokensOf("1000000000001")).toBeNull();
	});
});

describe("UsageBudgets", () => {
	it("shows the organization's budget, each budget and the last alerts", async () => {
		render(<UsageBudgets />);
		expect(await screen.findByText(/2.5M of 10M tokens this month \(25%\)/)).toBeInTheDocument();
		const list = section("Budgets");
		expect(within(list).getByText("Ada")).toBeInTheDocument();
		expect(within(list).getByText("120%")).toBeInTheDocument();
		expect(within(list).getByText("Unknown")).toBeInTheDocument();
		expect(within(list).getByText("team")).toBeInTheDocument();
		expect(within(list).getAllByText("Yes")).toHaveLength(1);
		const alerts = section("Last alerts");
		expect(within(alerts).getByText("Ada")).toBeInTheDocument();
		expect(within(alerts).getByText("Organization budget")).toBeInTheDocument();
		expect(within(alerts).getByText("Unknown")).toBeInTheDocument();
		expect(within(alerts).getAllByText("November 2026")).toHaveLength(2);
	});

	it("says when there is no budget and no alert yet", async () => {
		serverUsage.getBudgets.mockResolvedValue({ ok: true, data: { organization: null, budgets: [], alerts: [] } });
		render(<UsageBudgets />);
		expect(await screen.findByText(/No organization budget/)).toBeInTheDocument();
		expect(screen.getByText("No budget yet.")).toBeInTheDocument();
		expect(screen.getByText("No alert yet.")).toBeInTheDocument();
	});

	it("sets a budget for a group, and clears the form once the server took it", async () => {
		serverUsage.setBudget.mockResolvedValue({ ok: true, data: BUDGETS });
		render(<UsageBudgets />);
		const save = await screen.findByRole("button", { name: "Set the budget" });
		expect(save).toBeDisabled();
		const target = screen.getByLabelText("Who");
		expect(within(target).getByText("bob@example.com")).toBeInTheDocument();
		fireEvent.change(target, { target: { value: "u1" } });
		fireEvent.change(screen.getByLabelText("For"), { target: { value: "group" } });
		expect(target).toHaveValue("");
		fireEvent.change(target, { target: { value: "g1" } });
		fireEvent.change(screen.getByLabelText("Monthly tokens"), { target: { value: "0" } });
		expect(screen.getByText(/A whole number of tokens/)).toBeInTheDocument();
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Monthly tokens"), { target: { value: "3 000 000" } });
		fireEvent.click(screen.getByLabelText("Refuse new runs once it is spent"));
		fireEvent.click(save);
		await vi.waitFor(() => expect(screen.getByLabelText("Monthly tokens")).toHaveValue(""));
		expect(serverUsage.setBudget).toHaveBeenCalledWith({
			scope: "group",
			target_id: "g1",
			monthly_tokens: 3_000_000,
			block: true,
		});
		fireEvent.change(screen.getByLabelText("For"), { target: { value: "project" } });
		expect(within(screen.getByLabelText("Who")).getByText("Shop")).toBeInTheDocument();
	});

	it("keeps the form and shows a refusal", async () => {
		serverUsage.setBudget.mockResolvedValue({ ok: false, error: "No such person" });
		render(<UsageBudgets />);
		await screen.findByRole("button", { name: "Set the budget" });
		fireEvent.change(screen.getByLabelText("Who"), { target: { value: "u2" } });
		fireEvent.change(screen.getByLabelText("Monthly tokens"), { target: { value: "1000" } });
		fireEvent.click(screen.getByRole("button", { name: "Set the budget" }));
		expect(await screen.findByText("The server refused: No such person")).toBeInTheDocument();
		expect(screen.getByLabelText("Monthly tokens")).toHaveValue("1000");
	});

	it("fills the form from a budget to change it, and removes one", async () => {
		serverUsage.removeBudget.mockResolvedValue({
			ok: true,
			data: { ...BUDGETS, budgets: BUDGETS.budgets.slice(1) },
		});
		render(<UsageBudgets />);
		await screen.findByText("Budgets", { selector: "h3" });
		const list = section("Budgets");
		fireEvent.click(within(list).getByRole("button", { name: "Team A" }));
		expect(screen.getByLabelText("For")).toHaveValue("group");
		expect(screen.getByLabelText("Who")).toHaveValue("g1");
		expect(screen.getByLabelText("Monthly tokens")).toHaveValue("2000000");
		expect(screen.getByLabelText("Refuse new runs once it is spent")).not.toBeChecked();
		fireEvent.click(within(list).getByRole("button", { name: "Ada" }));
		expect(screen.getByLabelText("Refuse new runs once it is spent")).toBeChecked();
		// A budget of a scope the app does not know is not offered to change.
		fireEvent.click(within(list).getByRole("button", { name: "Odd" }));
		expect(screen.getByLabelText("For")).toHaveValue("person");
		fireEvent.click(within(list).getByRole("button", { name: "Remove the budget of Ada" }));
		await vi.waitFor(() => expect(within(section("Budgets")).queryByRole("button", { name: "Ada" })).toBeNull());
		expect(serverUsage.removeBudget).toHaveBeenCalledWith("b1");
	});

	it("does nothing once the bridge is gone", async () => {
		render(<UsageBudgets />);
		await screen.findByRole("button", { name: "Set the budget" });
		fireEvent.change(screen.getByLabelText("Who"), { target: { value: "u2" } });
		fireEvent.change(screen.getByLabelText("Monthly tokens"), { target: { value: "1000" } });
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		fireEvent.click(screen.getByRole("button", { name: "Set the budget" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove the budget of Ada" }));
		expect(serverUsage.setBudget).not.toHaveBeenCalled();
		expect(serverUsage.removeBudget).not.toHaveBeenCalled();
	});

	it("is read-only without usage.write", async () => {
		grant("usage.read");
		render(<UsageBudgets />);
		const list = await screen.findByText("Budgets", { selector: "h3" });
		expect(within(list.closest("section") as HTMLElement).getByText("Ada")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
		expect(screen.queryByText("Add or change a budget")).not.toBeInTheDocument();
	});

	it("says when the server refuses to read them, and waits without a bridge", async () => {
		serverUsage.getBudgets.mockResolvedValue({ ok: false, error: "Forbidden" });
		render(<UsageBudgets />);
		expect(await screen.findByText("The server refused: Forbidden")).toBeInTheDocument();
		cleanup();
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		render(<UsageBudgets />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});
