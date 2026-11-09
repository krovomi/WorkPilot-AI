import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// dnd-kit requires each sortable id to be stable AND unique within its DndContext.
// Because items and groups share the same DndContext (needed so an item can be dragged
// onto the star of the rail), we namespace ids — `item:kanban`, `group:agents`.
// Parsing helpers below keep the rest of the codebase unaware of this.
export type SortableKind = "group" | "item";

/** The star of the rail (« Mon menu »): a page or a group dropped on it is pinned. */
export const FAV_DROP_ID = "__fav_drop__";

export function encodeSortableId(kind: SortableKind, id: string): string {
	return `${kind}:${id}`;
}

export function decodeSortableId(
	sortableId: string,
): { kind: SortableKind; id: string } | null {
	const sep = sortableId.indexOf(":");
	if (sep === -1) return null;
	const kind = sortableId.slice(0, sep) as SortableKind;
	const id = sortableId.slice(sep + 1);
	if (kind !== "group" && kind !== "item") return null;
	return { kind, id };
}

interface SortableWrapperProps {
	sortableId: string;
	disabled?: boolean;
	children: (args: {
		dragHandle: ReactNode;
		isDragging: boolean;
		setNodeRef: (node: HTMLElement | null) => void;
		style: CSSProperties;
	}) => ReactNode;
}

// Generic sortable wrapper. The drag handle is rendered via render-prop so callers
// decide exactly where it sits in their own markup — we don't wrap their layout.
export function SortableWrapper({
	sortableId,
	disabled,
	children,
}: SortableWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: sortableId, disabled });
	const { t } = useTranslation("navigation");

	const style: CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : 1,
		zIndex: isDragging ? 50 : undefined,
	};

	const dragHandle = (
		<button
			type="button"
			aria-label={t("actions.dragToReorder")}
			className={cn(
				"opacity-40 hover:opacity-100 focus-visible:opacity-100",
				"transition-opacity duration-150",
				"flex items-center justify-center w-4 h-4 shrink-0",
				"text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing",
			)}
			{...attributes}
			{...listeners}
		>
			<GripVertical className="h-3.5 w-3.5" />
		</button>
	);

	return <>{children({ dragHandle, isDragging, setNodeRef, style })}</>;
}
