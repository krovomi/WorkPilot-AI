/**
 * AccountPriorityList — every account in the order auto-switching uses them:
 * the one in use, the next one (wrapping round), the usage of each Claude
 * account, the warnings, and the new order when an account is dropped elsewhere.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import { act, cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../ui/tooltip";
import { AccountPriorityList, type UnifiedAccount } from "../AccountPriorityList";

// The app wraps every screen in one tooltip provider.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

// The drop itself needs a real pointer and layout; the list is given the event
// dnd-kit sends when an account is dropped on another.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as undefined | ((event: DragEndEvent) => void) }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/core")>();
	return {
		...actual,
		DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
			dnd.onDragEnd = props.onDragEnd;
			return <actual.DndContext {...props} />;
		},
	};
});

function account(id: string, extra: Partial<UnifiedAccount> = {}): UnifiedAccount {
	return {
		id,
		name: id,
		type: "oauth",
		displayName: `Account ${id}`,
		identifier: `${id}@example.com`,
		isActive: false,
		isNext: false,
		isAvailable: true,
		hasUnlimitedUsage: false,
		...extra,
	};
}

const drop = (active: string, over: string | null) =>
	act(() => dnd.onDragEnd?.({ active: { id: active }, over: over === null ? null : { id: over } } as DragEndEvent));

const rows = () => screen.getAllByRole("button", { name: /^Move / }).map((handle) => handle.parentElement as HTMLElement);

afterEach(() => {
	cleanup();
	dnd.onDragEnd = undefined;
});

describe("AccountPriorityList", () => {
	it("says when there is no account", () => {
		render(<AccountPriorityList accounts={[]} onReorder={vi.fn()} />);
		expect(screen.getByText("No accounts configured. Add accounts above to set priority.")).toBeInTheDocument();
	});

	it("numbers the accounts, marks the one in use and the next one, and shows each one's usage", () => {
		render(
			<AccountPriorityList
				accounts={[
					account("a", { sessionPercent: 20, weeklyPercent: 10 }),
					account("b", { isActive: true, sessionPercent: 75.4, weeklyPercent: 40 }),
					account("c", { isAvailable: false }),
					account("api", { type: "api", displayName: "Proxy", identifier: "https://proxy.example" }),
				]}
				onReorder={vi.fn()}
			/>,
		);
		const [a, b, c, api] = rows();
		expect(within(a).getByText("1")).toBeInTheDocument();
		expect(within(b).getByText("In Use")).toBeInTheDocument();
		expect(within(b).getByText("75%")).toBeInTheDocument();
		expect(within(b).getByText("40%")).toBeInTheDocument();
		expect(within(b).getByText("Moderate")).toBeInTheDocument();
		expect(within(a).getByText("Healthy")).toBeInTheDocument();
		// The next one after the one in use is the API endpoint, skipping the signed-out account.
		expect(within(api).getByText("Next")).toBeInTheDocument();
		expect(within(api).getByText("Pay-per-use")).toBeInTheDocument();
		expect(within(api).getByText("https://proxy.example")).toBeInTheDocument();
		expect(within(c).getByText("Not authenticated")).toBeInTheDocument();
		expect(within(c).queryByText(/%$/)).toBeNull();
		expect(within(a).queryByText("Next")).toBeNull();
	});

	it("wraps round for the next account, and takes the first available one when none is in use", () => {
		const { rerender } = render(
			<AccountPriorityList accounts={[account("a"), account("b", { isActive: true })]} onReorder={vi.fn()} />,
		);
		expect(within(rows()[0]).getByText("Next")).toBeInTheDocument();
		rerender(<AccountPriorityList accounts={[account("a", { isAvailable: false }), account("b")]} onReorder={vi.fn()} />);
		expect(within(rows()[1]).getByText("Next")).toBeInTheDocument();
		rerender(<AccountPriorityList accounts={[account("a", { isActive: true }), account("b", { isAvailable: false })]} onReorder={vi.fn()} />);
		expect(screen.queryByText("Next")).toBeNull();
	});

	it("names the usage level of each account", () => {
		render(
			<AccountPriorityList
				accounts={[
					account("high", { sessionPercent: 92, weeklyPercent: 10 }),
					account("near", { sessionPercent: 10, weeklyPercent: 96 }),
					account("limited", { sessionPercent: 0, isRateLimited: true }),
				]}
				onReorder={vi.fn()}
			/>,
		);
		const [high, near, limited] = rows();
		expect(within(high).getByText("High usage")).toBeInTheDocument();
		expect(within(near).getByText("Near limit")).toBeInTheDocument();
		expect(within(limited).getByText("Rate limited")).toBeInTheDocument();
		// A weekly figure not known yet shows as none.
		expect(within(limited).getAllByText("0%")).toHaveLength(2);
	});

	it("warns about Claude accounts with the very same usage, and about one to sign in again", () => {
		render(
			<AccountPriorityList
				accounts={[
					account("a", { sessionPercent: 30, weeklyPercent: 50 }),
					account("b", { sessionPercent: 30, weeklyPercent: 50, needsReauthentication: true }),
					// Unused accounts all read 0 %: not a duplicate.
					account("c", { sessionPercent: 0, weeklyPercent: 0 }),
					account("d", { sessionPercent: 0, weeklyPercent: 0 }),
					account("e", { sessionPercent: 30 }),
				]}
				onReorder={vi.fn()}
			/>,
		);
		const [a, b, c, d, e] = rows();
		expect(within(a).getByText("Duplicate usage detected")).toBeInTheDocument();
		expect(within(b).getByText("Duplicate usage detected")).toBeInTheDocument();
		expect(within(b).getByText("Needs re-auth")).toBeInTheDocument();
		for (const row of [c, d, e]) expect(within(row).queryByText("Duplicate usage detected")).toBeNull();
	});

	it("checks for the same usage only with two Claude accounts signed in", () => {
		render(
			<AccountPriorityList
				accounts={[account("a", { sessionPercent: 30, weeklyPercent: 50 }), account("b", { isAvailable: false, sessionPercent: 30, weeklyPercent: 50 })]}
				onReorder={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Duplicate usage detected")).toBeNull();
	});

	it("moves an account dropped on another and sends the new order, and follows a new list", () => {
		const onReorder = vi.fn();
		const { rerender } = render(<AccountPriorityList accounts={[account("a"), account("b"), account("c")]} onReorder={onReorder} />);
		drop("c", "a");
		expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
		expect(rows().map((row) => within(row).getByText(/^Account /).textContent)).toEqual(["Account c", "Account a", "Account b"]);

		// Dropped on itself or outside the list: nothing changes.
		drop("c", "c");
		drop("c", null);
		expect(onReorder).toHaveBeenCalledTimes(1);

		rerender(<AccountPriorityList accounts={[account("b"), account("a")]} onReorder={onReorder} isLoading />);
		expect(rows().map((row) => within(row).getByText(/^Account /).textContent)).toEqual(["Account b", "Account a"]);
	});
});
