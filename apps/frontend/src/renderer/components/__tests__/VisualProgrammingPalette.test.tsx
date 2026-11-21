/**
 * VisualProgrammingPalette — the architecture blocks and the person's own
 * bricks: search, folding groups, click or drag to place, create and edit a
 * brick. Real bricks store, real i18n.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { BLOCK_CATEGORIES } from "../../lib/architecture-blocks";
import type { CustomBrick } from "../../lib/custom-bricks";
import { useCustomBricksStore } from "../../stores/custom-bricks-store";
import { VisualProgrammingPalette } from "../VisualProgrammingPalette";

const CATALOGUE = BLOCK_CATEGORIES.reduce((n, c) => n + c.blocks.length, 0);

const HERMES: CustomBrick = {
	id: "brick-1",
	name: "Hermes",
	kicker: "Main agent",
	accent: "#3b82f6",
	icon: "bot",
	description: "Routes every request",
	stack: "",
};
const LEDGER: CustomBrick = {
	id: "brick-2",
	name: "Ledger",
	kicker: "",
	accent: "#22c55e",
	icon: "blocks",
	description: "",
	stack: "",
};

function dataTransfer() {
	return { setData: vi.fn(), effectAllowed: "" };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useCustomBricksStore.setState({ bricks: [] });
});

describe("VisualProgrammingPalette — catalogue", () => {
	it("counts and lists every block, each with its description", () => {
		render(<VisualProgrammingPalette />);
		expect(screen.getByText("Palette")).toBeInTheDocument();
		expect(screen.getByText(`${CATALOGUE} blocks`)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^FrontEnd$/ }),
		).toHaveAttribute("title", "Web interface (React, Angular, Vue, Svelte…)");
		expect(
			screen.getByText("Drag a block onto the canvas, or click it."),
		).toBeInTheDocument();
	});

	it("adds a block on click, and works without a click handler", () => {
		const onAddBlock = vi.fn();
		const { rerender } = render(
			<VisualProgrammingPalette onAddBlock={onAddBlock} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /^FrontEnd$/ }));
		expect(onAddBlock).toHaveBeenCalledWith("frontend");
		rerender(<VisualProgrammingPalette />);
		fireEvent.click(screen.getByRole("button", { name: /^FrontEnd$/ }));
		expect(onAddBlock).toHaveBeenCalledTimes(1);
	});

	it("carries the block type in a drag", () => {
		render(<VisualProgrammingPalette />);
		const dt = dataTransfer();
		fireEvent.dragStart(screen.getByRole("button", { name: /^FrontEnd$/ }), {
			dataTransfer: dt,
		});
		expect(dt.setData).toHaveBeenCalledWith("application/block-type", "frontend");
		expect(dt.effectAllowed).toBe("copy");
	});

	it("folds and unfolds a group", () => {
		render(<VisualProgrammingPalette />);
		const group = screen.getByRole("button", { name: /^Frontend\s*3$/ });
		expect(group).toHaveAttribute("aria-expanded", "true");
		fireEvent.click(group);
		expect(group).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("button", { name: /^FrontEnd$/ }),
		).not.toBeInTheDocument();
		fireEvent.click(group);
		expect(screen.getByRole("button", { name: /^FrontEnd$/ })).toBeInTheDocument();
	});

	it("shows search results even in a folded group, and clears the search", () => {
		render(<VisualProgrammingPalette />);
		fireEvent.click(screen.getByRole("button", { name: /^Frontend\s*3$/ }));
		const search = screen.getByRole("searchbox", { name: "Search a block…" });
		fireEvent.change(search, { target: { value: "desktop" } });
		expect(screen.getByRole("button", { name: /^Desktop app$/ })).toBeInTheDocument();
		expect(screen.getByText("1 blocks")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(search).toHaveValue("");
		expect(
			screen.queryByRole("button", { name: "Clear search" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Desktop app$/ }),
		).not.toBeInTheDocument();
	});

	it("says when nothing matches", () => {
		render(<VisualProgrammingPalette />);
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "zzzz-nothing" },
		});
		expect(screen.getByText("No block matches.")).toBeInTheDocument();
		expect(screen.getByText("0 blocks")).toBeInTheDocument();
	});
});

describe("VisualProgrammingPalette — my bricks", () => {
	it("invites to create a first brick and opens the editor", () => {
		render(<VisualProgrammingPalette />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Create your own bricks: an agent, a business engine, an existing system…",
			}),
		);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("New brick")).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("opens the editor from the + button", () => {
		render(<VisualProgrammingPalette />);
		fireEvent.click(screen.getByRole("button", { name: "New brick" }));
		expect(
			within(screen.getByRole("dialog")).getByText("New brick"),
		).toBeInTheDocument();
	});

	it("lists the bricks above the catalogue, placed by click or drag", () => {
		useCustomBricksStore.setState({ bricks: [HERMES, LEDGER] });
		const onAddBlock = vi.fn();
		render(<VisualProgrammingPalette onAddBlock={onAddBlock} />);
		expect(screen.getByText(`${CATALOGUE + 2} blocks`)).toBeInTheDocument();
		const hermes = screen.getByRole("button", { name: /Hermes\s*Main agent/ });
		expect(hermes).toHaveAttribute("title", "Routes every request");
		const ledger = screen.getByRole("button", { name: /^Ledger$/ });
		expect(ledger).toHaveAttribute("title", "Ledger");
		expect(
			screen.queryByRole("button", { name: /Create your own bricks/ }),
		).not.toBeInTheDocument();

		fireEvent.click(hermes);
		expect(onAddBlock).toHaveBeenCalledWith("brick:brick-1");
		const dt = dataTransfer();
		fireEvent.dragStart(ledger, { dataTransfer: dt });
		expect(dt.setData).toHaveBeenCalledWith(
			"application/block-type",
			"brick:brick-2",
		);
	});

	it("edits a brick from its pencil", () => {
		useCustomBricksStore.setState({ bricks: [HERMES] });
		render(<VisualProgrammingPalette />);
		fireEvent.click(screen.getByRole("button", { name: "Edit brick" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Edit brick")).toBeInTheDocument();
		expect(within(dialog).getByDisplayValue("Hermes")).toBeInTheDocument();
	});

	it("folds the bricks, and finds them by name, role or description", () => {
		useCustomBricksStore.setState({ bricks: [HERMES, LEDGER] });
		render(<VisualProgrammingPalette />);
		const group = screen.getByRole("button", { name: /^My bricks\s*2$/ });
		fireEvent.click(group);
		expect(group).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("button", { name: /^Ledger$/ }),
		).not.toBeInTheDocument();

		const search = screen.getByRole("searchbox");
		fireEvent.change(search, { target: { value: "routes" } });
		expect(screen.getByRole("button", { name: /^My bricks\s*1$/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(screen.getByRole("button", { name: /Hermes/ })).toBeInTheDocument();
		fireEvent.change(search, { target: { value: "LEDG" } });
		expect(screen.getByRole("button", { name: /^Ledger$/ })).toBeInTheDocument();
		// A brick that matches keeps the "nothing matches" line away.
		expect(screen.queryByText("No block matches.")).not.toBeInTheDocument();
		fireEvent.change(search, { target: { value: "main agent" } });
		expect(screen.getByRole("button", { name: /Hermes/ })).toBeInTheDocument();
	});
});
