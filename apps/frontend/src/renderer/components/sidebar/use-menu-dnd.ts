import {
	type Announcements,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { SidebarPrefs } from "@shared/types/settings";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	moveItemToGroup,
	reorderGroup,
	reorderItem,
	reorderPins,
} from "./menu-layout";
import type { NavGroup } from "./nav-model";
import { decodeSortableId, FAV_DROP_ID } from "./sortable-primitives";

interface MenuDndOptions {
	/** The groups as the code ships them (forge and administration entries added). */
	readonly shipped: readonly NavGroup[];
	/** The same groups as the person arranged them (`applyMenuLayout`). */
	readonly arranged: readonly NavGroup[];
	readonly arrange: (build: (current: SidebarPrefs) => Partial<SidebarPrefs> | null) => void;
	readonly pinItem: (itemId: string) => void;
	readonly pinGroup: (groupId: string) => void;
	/** The menu entry a pin stands for (a hub's tab pins its hub's entry). */
	readonly entryOfPin: (pin: string) => string;
}

/**
 * What a drag in the menu does (F181 follow-up, « personnaliser le menu »):
 *
 * - a page onto a page of its space: its new place;
 * - a page onto a space of the rail: the page moves to that space;
 * - a page or a space onto the star: pinned to « Mon menu »;
 * - a pin onto a pin: the pins' new order;
 * - a space onto a space: the rail's new order.
 *
 * The pointer starts a drag after 6 px, so a click stays a click; the
 * keyboard picks a grip up with Space or Enter, moves it with the arrows,
 * drops it with Space and cancels with Escape. What happens is announced to
 * screen readers in the app's language.
 */
export function useMenuDnd({ shipped, arranged, arrange, pinItem, pinGroup, entryOfPin }: MenuDndOptions) {
	const { t } = useTranslation("navigation");
	const [activeDragId, setActiveDragId] = useState<string | null>(null);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const labelOf = useCallback(
		(sortableId: string | number | undefined): string | null => {
			if (sortableId === undefined) return null;
			if (sortableId === FAV_DROP_ID) return t("spaces.mine");
			const info = decodeSortableId(String(sortableId));
			if (!info) return null;
			if (info.kind === "group") {
				const group = arranged.find((g) => g.id === info.id);
				return group ? t(group.labelKey) : null;
			}
			const item = arranged.flatMap((g) => g.items).find((i) => i.id === info.id);
			return item ? t(item.labelKey) : null;
		},
		[arranged, t],
	);

	const onDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);

	const onDragCancel = useCallback(() => setActiveDragId(null), []);

	const onDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			setActiveDragId(null);
			if (!over) return;
			const from = decodeSortableId(String(active.id));
			if (!from) return;
			// The star has no kind, so it is checked before decoding.
			if (over.id === FAV_DROP_ID) {
				if (from.kind === "item") pinItem(from.id);
				else if (from.kind === "group") pinGroup(from.id);
				return;
			}
			const to = decodeSortableId(String(over.id));
			if (!to) return;
			if (from.kind === "group" && to.kind === "group") {
				arrange((current) => reorderGroup(current, arranged, from.id, to.id));
			} else if (from.kind === "item" && to.kind === "group") {
				arrange((current) => moveItemToGroup(current, shipped, arranged, from.id, to.id));
			} else if (from.kind === "item" && to.kind === "item") {
				const group = arranged.find((g) => g.items.some((i) => i.id === from.id));
				if (group) arrange((current) => reorderItem(current, arranged, group.id, from.id, to.id));
			} else if (from.kind === "pin" && to.kind === "pin") {
				arrange((current) => {
					const pinnedItems = reorderPins(current.pinnedItems, entryOfPin, from.id, to.id);
					return pinnedItems ? { pinnedItems } : null;
				});
			}
		},
		[arranged, shipped, arrange, pinItem, pinGroup, entryOfPin],
	);

	const announcements = useMemo<Announcements>(
		() => ({
			onDragStart: ({ active }) => t("customize.announce.start", { name: labelOf(active.id) ?? "" }),
			onDragOver: ({ active, over }) =>
				over
					? t("customize.announce.over", { name: labelOf(active.id) ?? "", target: labelOf(over.id) ?? "" })
					: t("customize.announce.outside", { name: labelOf(active.id) ?? "" }),
			onDragEnd: ({ active, over }) =>
				over
					? t("customize.announce.drop", { name: labelOf(active.id) ?? "", target: labelOf(over.id) ?? "" })
					: t("customize.announce.cancel", { name: labelOf(active.id) ?? "" }),
			onDragCancel: ({ active }) => t("customize.announce.cancel", { name: labelOf(active.id) ?? "" }),
		}),
		[labelOf, t],
	);

	const accessibility = useMemo(
		() => ({ announcements, screenReaderInstructions: { draggable: t("customize.announce.instructions") } }),
		[announcements, t],
	);

	return {
		sensors,
		activeDragId,
		dragLabel: labelOf,
		accessibility,
		onDragStart,
		onDragEnd,
		onDragCancel,
	};
}
