/**
 * @vitest-environment jsdom
 *
 * What a drag in the menu says and does, read on the hook alone: the names
 * it gives to a screen reader, and the drops that mean nothing.
 */
import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from "@shared/types/settings";
import { act, renderHook } from "@testing-library/react";
import { Star } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { SidebarView } from "../../Sidebar";
import type { NavGroup } from "../nav-model";
import { useMenuDnd } from "../use-menu-dnd";

const GROUPS: NavGroup[] = [
	{
		id: "workspace",
		labelKey: "navigation:groups.workspace",
		icon: Star,
		items: [{ id: "kanban" as SidebarView, labelKey: "navigation:items.kanban", icon: Star }],
	},
	{ id: "agents", labelKey: "navigation:groups.agents", icon: Star, items: [] },
];

function setup() {
	let prefs: SidebarPrefs = { ...DEFAULT_SIDEBAR_PREFS };
	const arrange = vi.fn((build: (current: SidebarPrefs) => Partial<SidebarPrefs> | null) => {
		prefs = { ...prefs, ...build(prefs) };
	});
	const pinItem = vi.fn();
	const pinGroup = vi.fn();
	const { result } = renderHook(() =>
		useMenuDnd({ shipped: GROUPS, arranged: GROUPS, arrange, pinItem, pinGroup, entryOfPin: (pin) => pin }),
	);
	return { result, arrange, pinItem, pinGroup, prefs: () => prefs };
}

const drag = (id: string) => ({ id, data: { current: undefined }, rect: { current: { initial: null, translated: null } } });

describe("useMenuDnd", () => {
	it("names what is dragged and where, in the app's language", () => {
		const { result } = setup();
		const { announcements, screenReaderInstructions } = result.current.accessibility;
		const active = drag("item:kanban") as never;
		expect(screenReaderInstructions.draggable).toContain("press Space or Enter");
		expect(announcements.onDragStart({ active })).toBe("Picked up Kanban board.");
		expect(announcements.onDragOver?.({ active, over: drag("group:agents") as never })).toBe(
			"Kanban board is over Agents.",
		);
		expect(announcements.onDragOver?.({ active, over: null })).toBe(
			"Kanban board is no longer over a place it can go.",
		);
		expect(announcements.onDragEnd({ active, over: drag("__fav_drop__") as never })).toBe(
			"Kanban board was dropped on My menu.",
		);
		expect(announcements.onDragEnd({ active, over: null })).toBe("Moving Kanban board was cancelled.");
		expect(announcements.onDragCancel({ active, over: null })).toBe("Moving Kanban board was cancelled.");
		expect(announcements.onDragStart({ active: drag("nokind") as never })).toBe("Picked up .");
		expect(announcements.onDragStart({ active: drag("item:gone") as never })).toBe("Picked up .");
		expect(announcements.onDragStart({ active: drag("group:gone") as never })).toBe("Picked up .");
		expect(
			announcements.onDragOver?.({ active: drag("nokind") as never, over: drag("nokind") as never }),
		).toBe(" is over .");
		expect(
			announcements.onDragEnd({ active: drag("nokind") as never, over: drag("nokind") as never }),
		).toBe(" was dropped on .");
		expect(announcements.onDragOver?.({ active: drag("nokind") as never, over: null })).toBe(
			" is no longer over a place it can go.",
		);
		expect(announcements.onDragEnd({ active: drag("nokind") as never, over: null })).toBe(
			"Moving  was cancelled.",
		);
		expect(announcements.onDragCancel({ active: drag("nokind") as never, over: null })).toBe(
			"Moving  was cancelled.",
		);
		expect(result.current.dragLabel(undefined)).toBeNull();
	});

	it("tracks the drag shown in the overlay", () => {
		const { result } = setup();
		act(() => result.current.onDragStart({ active: drag("item:kanban") } as never));
		expect(result.current.activeDragId).toBe("item:kanban");
		act(() => result.current.onDragCancel());
		expect(result.current.activeDragId).toBeNull();
	});

	it("moves a page to a space, pins on the star, and ignores a page it does not know", () => {
		const { result, arrange, pinItem, pinGroup, prefs } = setup();
		act(() => result.current.onDragEnd({ active: drag("item:kanban"), over: drag("group:agents") } as never));
		expect(prefs().itemGroups).toEqual({ kanban: "agents" });
		act(() => result.current.onDragEnd({ active: drag("item:kanban"), over: drag("__fav_drop__") } as never));
		act(() => result.current.onDragEnd({ active: drag("group:agents"), over: drag("__fav_drop__") } as never));
		act(() => result.current.onDragEnd({ active: drag("pin:kanban"), over: drag("__fav_drop__") } as never));
		expect(pinItem).toHaveBeenCalledWith("kanban");
		expect(pinGroup).toHaveBeenCalledWith("agents");
		arrange.mockClear();
		act(() => result.current.onDragEnd({ active: drag("item:gone"), over: drag("item:kanban") } as never));
		expect(arrange).not.toHaveBeenCalled();
	});
});
