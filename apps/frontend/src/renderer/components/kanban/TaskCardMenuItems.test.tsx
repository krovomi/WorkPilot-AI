/**
 * The card's action list, shared by its "⋮" menu and its right-click menu:
 * each action shows only when the card offers it, in two groups, delete last.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pickSubmenuItem } from "../../../__tests__/helpers/menus";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TaskCardMenuItems } from "./TaskCardMenuItems";

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

function renderItems(props: ComponentProps<typeof TaskCardMenuItems>) {
	return render(
		<DropdownMenu open>
			<DropdownMenuTrigger>menu</DropdownMenuTrigger>
			<DropdownMenuContent>
				<TaskCardMenuItems {...props} />
			</DropdownMenuContent>
		</DropdownMenu>,
	);
}

const separators = () => document.querySelectorAll('[role="separator"]').length;

describe("TaskCardMenuItems", () => {
	it("flags a task as blocked, or lifts the flag", async () => {
		const user = userEvent.setup();
		const onFlag = vi.fn();
		const { unmount } = renderItems({ onFlag });
		await user.click(screen.getByRole("menuitem", { name: "Flag as blocked…" }));
		expect(onFlag).toHaveBeenCalled();
		unmount();
		const onUnflag = vi.fn();
		renderItems({ onUnflag });
		await user.click(screen.getByRole("menuitem", { name: "Remove flag" }));
		expect(onUnflag).toHaveBeenCalled();
	});

	it("sets a task aside, or resumes it, from the work group", async () => {
		const user = userEvent.setup();
		const onAbandon = vi.fn();
		const { unmount } = renderItems({ onAbandon, onDelete: vi.fn() });
		expect(separators()).toBe(1);
		await user.click(screen.getByRole("menuitem", { name: "Abandon…" }));
		expect(onAbandon).toHaveBeenCalled();
		unmount();
		const onUnabandon = vi.fn();
		renderItems({ onUnabandon });
		await user.click(screen.getByRole("menuitem", { name: "Resume" }));
		expect(onUnabandon).toHaveBeenCalled();
	});

	it("shows delete alone, without a separator", () => {
		renderItems({ onDelete: vi.fn() });
		expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Delete"]);
		expect(separators()).toBe(0);
	});

	it("separates the work actions from delete", () => {
		renderItems({ onDuplicate: vi.fn(), onDelete: vi.fn() });
		expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
			"Duplicate",
			"Delete",
		]);
		expect(separators()).toBe(1);
	});

	it("separates the edit group from the work group", () => {
		renderItems({ onEdit: vi.fn(), onEstimate: vi.fn() });
		expect(separators()).toBe(1);
	});

	it("leaves out moving when there is nowhere to go", () => {
		renderItems({ onEdit: vi.fn(), moves: { targets: [], onMove: vi.fn() } });
		expect(screen.queryByRole("menuitem", { name: "Move to" })).toBeNull();
		expect(separators()).toBe(0);
	});

	it("moves to a column of its submenu", async () => {
		const user = userEvent.setup();
		const onMove = vi.fn();
		renderItems({ moves: { targets: ["queue", "done"], onMove } });
		await pickSubmenuItem(user, "Move to", "Done");
		expect(onMove).toHaveBeenCalledWith("done");
	});

	it("marks the card's own type and priority", async () => {
		const user = userEvent.setup();
		renderItems({
			onSetType: vi.fn(),
			onSetPriority: vi.fn(),
			currentType: "docs",
			currentPriority: "low",
		});
		screen.getByRole("menuitem", { name: "Type" }).focus();
		await user.keyboard("{ArrowRight}");
		const docs = await screen.findByRole("menuitem", { name: "Docs" });
		expect(docs.querySelectorAll("svg")).toHaveLength(2);
		expect(
			screen.getByRole("menuitem", { name: "Bug" }).querySelectorAll("svg"),
		).toHaveLength(1);
	});
});
