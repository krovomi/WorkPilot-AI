import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ViewBadge } from "@/stores/activity-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ActivityBadge } from "./ActivityBadge";
import { encodeSortableId, FAV_DROP_ID } from "./sortable-primitives";

export interface RailSpace {
	readonly id: string;
	readonly labelKey: string;
	readonly icon: LucideIcon;
	readonly badge: ViewBadge | null;
	readonly attention: boolean;
	/** A number on the icon's corner (the pages of the Labo). */
	readonly count?: number;
	/** The space's entries, shown beside the icon while the panel is folded. */
	readonly preview?: ReactNode;
}

interface SidebarRailProps {
	/** « Mon menu », shown first and never reordered. */
	readonly mine: RailSpace;
	/** One space per group, in the user's order; dragging one reorders them. */
	readonly groups: readonly RailSpace[];
	/** Spaces under the groups, apart (the Labo). */
	readonly extras?: readonly RailSpace[];
	readonly activeSpace: string;
	readonly isCollapsed: boolean;
	readonly onSelect: (spaceId: string) => void;
	/** The CLI chip, setup, help, settings and the fold toggle. */
	readonly footer: ReactNode;
}

/**
 * The first level of the menu (F181, lot 2): one icon per space. Choosing one
 * shows its pages in the panel beside it; with the panel folded, hovering one
 * lists its pages and choosing one unfolds the panel. Dropping a page on the
 * star pins it to « Mon menu ».
 */
export function SidebarRail({
	mine,
	groups,
	extras = [],
	activeSpace,
	isCollapsed,
	onSelect,
	footer,
}: SidebarRailProps) {
	const { t } = useTranslation("navigation");
	return (
		<nav
			aria-label={t("rail.label")}
			className="flex w-13 shrink-0 flex-col items-center border-r border-border bg-sidebar"
		>
			<div className="electron-drag flex h-14 w-full shrink-0 items-end justify-center pb-1">
				<div className="electron-no-drag flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
					W
				</div>
			</div>
			<div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
				<MineButton
					space={mine}
					active={activeSpace === mine.id}
					isCollapsed={isCollapsed}
					onSelect={onSelect}
				/>
				<span aria-hidden="true" className="my-1 h-px w-6 shrink-0 bg-border" />
				<SortableContext
					items={groups.map((space) => encodeSortableId("group", space.id))}
					strategy={verticalListSortingStrategy}
				>
					{groups.map((space) => (
						<SortableRailButton
							key={space.id}
							space={space}
							active={activeSpace === space.id}
							isCollapsed={isCollapsed}
							onSelect={onSelect}
						/>
					))}
				</SortableContext>
				{extras.length > 0 && (
					<>
						<span aria-hidden="true" className="flex-1" />
						{extras.map((space) => (
							<RailButton
								key={space.id}
								space={space}
								active={activeSpace === space.id}
								isCollapsed={isCollapsed}
								onSelect={onSelect}
							/>
						))}
					</>
				)}
			</div>
			<div className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-border py-2">
				{footer}
			</div>
		</nav>
	);
}

interface RailButtonProps {
	readonly space: RailSpace;
	readonly active: boolean;
	readonly isCollapsed: boolean;
	readonly onSelect: (spaceId: string) => void;
	readonly buttonRef?: (node: HTMLElement | null) => void;
	readonly buttonProps?: Record<string, unknown>;
	readonly dropTarget?: boolean;
}

function RailButton({
	space,
	active,
	isCollapsed,
	onSelect,
	buttonRef,
	buttonProps,
	dropTarget,
}: RailButtonProps) {
	const { t } = useTranslation("navigation");
	const Icon = space.icon;
	const label = t(space.labelKey);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					ref={buttonRef}
					type="button"
					onClick={() => onSelect(space.id)}
					aria-label={label}
					aria-pressed={active}
					data-space={space.id}
					{...buttonProps}
					className={cn(
						"relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors",
						"hover:bg-accent hover:text-accent-foreground",
						active && "bg-primary/15 text-primary",
						active &&
							"before:absolute before:top-2 before:bottom-2 before:-left-2 before:w-0.75 before:rounded-full before:bg-primary",
						dropTarget && "ring-2 ring-warning",
					)}
				>
					<Icon className="h-4.5 w-4.5" />
					{space.count !== undefined && (
						<span className="absolute -top-0.5 -right-0.5 rounded-full bg-warning px-1 text-3xs font-bold leading-4 text-background tabular-nums">
							{space.count}
						</span>
					)}
					<ActivityBadge badge={space.badge} attention={space.attention} variant="corner" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="right" className={cn(isCollapsed && space.preview && "max-w-xs")}>
				{isCollapsed && space.preview ? (
					<div className="space-y-2">
						<p className="text-sm font-medium">{label}</p>
						<div className="space-y-1">{space.preview}</div>
					</div>
				) : (
					label
				)}
			</TooltipContent>
		</Tooltip>
	);
}

/** The star: « Mon menu », and where a dragged page is dropped to pin it. */
function MineButton(props: Omit<RailButtonProps, "buttonRef" | "dropTarget">) {
	const { setNodeRef, isOver } = useDroppable({ id: FAV_DROP_ID });
	return <RailButton {...props} buttonRef={setNodeRef} dropTarget={isOver} />;
}

/** A group's icon, which the pointer can drag to reorder the spaces. */
function SortableRailButton(props: Omit<RailButtonProps, "buttonRef" | "buttonProps">) {
	const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
		id: encodeSortableId("group", props.space.id),
	});
	return (
		<div
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.4 : 1,
			}}
		>
			<RailButton
				{...props}
				buttonRef={setNodeRef}
				// Pointer only: Enter and Space keep choosing the space.
				buttonProps={{ onPointerDown: listeners?.onPointerDown }}
			/>
		</div>
	);
}
