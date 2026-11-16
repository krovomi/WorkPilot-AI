/**
 * The bar above the PR list: a search, a contributor and a status filter
 * (several values each), a sort and a reset. Driven by a parent that keeps
 * the filters, as the PR view does.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PRFilterState } from "../../hooks/usePRFiltering";
import { PRFilterBar } from "../PRFilterBar";

const NO_FILTER: PRFilterState = {
	searchQuery: "",
	contributors: [],
	statuses: [],
	sortBy: "newest",
};

function Harness({
	contributors = ["alice", "bob", "carol"],
	initial = NO_FILTER,
	onClear = vi.fn(),
}: {
	contributors?: string[];
	initial?: PRFilterState;
	onClear?: () => void;
}) {
	const [filters, setFilters] = useState(initial);
	const active =
		filters.searchQuery !== "" ||
		filters.contributors.length > 0 ||
		filters.statuses.length > 0;
	return (
		<>
			<output data-testid="filters">{JSON.stringify(filters)}</output>
			<PRFilterBar
				filters={filters}
				contributors={contributors}
				hasActiveFilters={active}
				onSearchChange={(searchQuery) => setFilters((f) => ({ ...f, searchQuery }))}
				onContributorsChange={(c) => setFilters((f) => ({ ...f, contributors: c }))}
				onStatusesChange={(statuses) => setFilters((f) => ({ ...f, statuses }))}
				onSortChange={(sortBy) => setFilters((f) => ({ ...f, sortBy }))}
				onClearFilters={() => {
					onClear();
					setFilters(NO_FILTER);
				}}
			/>
		</>
	);
}

const filters = (): PRFilterState =>
	JSON.parse(screen.getByTestId("filters").textContent ?? "{}");

/** Radix opens a menu from the keyboard in jsdom. */
async function open(name: RegExp) {
	const trigger = screen.getByRole("button", { name });
	trigger.focus();
	await userEvent.keyboard("{Enter}");
	return screen.getByRole("listbox");
}

describe("PRFilterBar", () => {
	it("searches, and clears the search", async () => {
		render(<Harness />);
		expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
		await userEvent.type(screen.getByPlaceholderText("Search PRs..."), "fix");
		expect(filters().searchQuery).toBe("fix");
		await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(filters().searchQuery).toBe("");
	});

	it("picks several contributors, narrows the list, and clears them", async () => {
		render(<Harness />);
		let list = await open(/Contributors/);
		await userEvent.click(within(list).getByText("alice"));
		await userEvent.click(within(list).getByText("bob"));
		expect(filters().contributors).toEqual(["alice", "bob"]);
		expect(within(list).getByRole("option", { name: /alice/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		// Clicking a picked one drops it.
		await userEvent.click(within(list).getByText("alice"));
		expect(filters().contributors).toEqual(["bob"]);

		const search = screen.getByPlaceholderText("Search contributors...");
		await userEvent.type(search, "CAR");
		expect(within(list).getAllByRole("option")).toHaveLength(1);
		await userEvent.clear(search);
		await userEvent.type(search, "zed");
		expect(within(list).queryByRole("option")).toBeNull();
		expect(within(list).getByText("No results found")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(filters().contributors).toEqual([]);

		// Closing forgets the search.
		await userEvent.keyboard("{Escape}");
		list = await open(/Contributors/);
		expect(within(list).getAllByRole("option")).toHaveLength(3);
	});

	it("moves through the options with the keyboard", async () => {
		render(<Harness />);
		const list = await open(/Contributors/);
		// Nothing focused yet: Enter picks nothing.
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().contributors).toEqual([]);

		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().contributors).toEqual(["alice"]);
		// Up from the first wraps to the last, down from the last to the first.
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: " " });
		expect(filters().contributors).toEqual(["alice", "carol"]);
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().contributors).toEqual(["carol"]);
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().contributors).toEqual(["carol", "bob"]);

		// An option takes Enter and Space itself, and only it changes: the
		// list's focused option (bob) used to be toggled with it.
		const alice = within(list).getByRole("option", { name: /alice/ });
		fireEvent.keyDown(alice, { key: "Enter" });
		fireEvent.keyDown(alice, { key: "Tab" });
		expect(filters().contributors).toEqual(["carol", "bob", "alice"]);
		fireEvent.keyDown(alice, { key: " " });
		expect(filters().contributors).toEqual(["carol", "bob"]);

		fireEvent.keyDown(list, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("ignores the keyboard when no contributor is left to pick", async () => {
		render(<Harness contributors={[]} />);
		const list = await open(/Contributors/);
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().contributors).toEqual([]);
	});

	it("names up to two picks on the button, then counts them", () => {
		const { unmount } = render(
			<Harness initial={{ ...NO_FILTER, contributors: ["alice", "bob"] }} />,
		);
		const button = screen.getByRole("button", { name: /Contributors/ });
		expect(within(button).getByText("alice")).toBeInTheDocument();
		expect(within(button).getByText("2")).toBeInTheDocument();
		unmount();

		render(
			<Harness
				initial={{ ...NO_FILTER, contributors: ["alice", "bob", "carol"] }}
			/>,
		);
		expect(screen.getByText("3 selected")).toBeInTheDocument();
	});

	it("filters on review statuses, named on the button", async () => {
		render(<Harness />);
		const list = await open(/All statuses/);
		expect(within(list).getAllByRole("option")).toHaveLength(7);
		await userEvent.click(within(list).getByText("Ready to Merge"));
		await userEvent.click(within(list).getByText("Posted"));
		expect(filters().statuses).toEqual(["ready_to_merge", "posted"]);
		await userEvent.keyboard("{Escape}");
		const button = screen.getByRole("button", { name: /All statuses/ });
		expect(within(button).getByText("Ready to Merge")).toBeInTheDocument();
		expect(within(button).getByText("Posted")).toBeInTheDocument();
	});

	it("sorts by one order at a time, by mouse or keyboard", async () => {
		render(<Harness />);
		const button = screen.getByRole("button", { name: /Sort/ });
		expect(within(button).getByText("Newest")).toBeInTheDocument();

		let list = await open(/Sort/);
		await userEvent.click(within(list).getByText("Largest"));
		expect(filters().sortBy).toBe("largest");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(within(button).getByText("Largest")).toBeInTheDocument();

		// Opening focuses the current order; down wraps to the first.
		list = await open(/Sort/);
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: "Enter" });
		expect(filters().sortBy).toBe("newest");

		list = await open(/Sort/);
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: "ArrowUp" });
		fireEvent.keyDown(list, { key: "ArrowDown" });
		fireEvent.keyDown(list, { key: " " });
		expect(filters().sortBy).toBe("largest");

		list = await open(/Sort/);
		fireEvent.keyDown(list, { key: "Tab" });
		fireEvent.keyDown(list, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(filters().sortBy).toBe("largest");
	});

	it("resets every filter, with a name even where its label is hidden", async () => {
		const onClear = vi.fn();
		render(<Harness onClear={onClear} />);
		expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
		await userEvent.type(screen.getByPlaceholderText("Search PRs..."), "x");
		await userEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(filters()).toEqual(NO_FILTER);
	});
});
