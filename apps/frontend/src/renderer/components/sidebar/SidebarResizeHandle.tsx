import type React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SIDEBAR_RAIL_WIDTH } from "./sidebar-width";

interface SidebarResizeHandleProps {
	/** Id of the panel the handle sizes (aria-controls). */
	readonly controls: string;
	/** Width of the menu as shown, in pixels. */
	readonly width: number;
	readonly maxWidth: number;
	readonly folded: boolean;
	readonly isResizing: boolean;
	/** The pointer moved since the press: a sheet covers the window. */
	readonly isDragging: boolean;
	readonly onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
	readonly onDoubleClick: () => void;
	readonly onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
	readonly onKeyUp: () => void;
}

/**
 * The right edge of the menu: drag it to widen or narrow the menu, far to the
 * left to fold it, double-click it to come back to the default width. Focused,
 * the arrows resize it and Enter folds or unfolds it (WAI-ARIA window
 * splitter). A thin line and a grip show on hover; while dragging, the pointer
 * is captured and a sheet covers the window, so terminals and web views never
 * catch it. The sheet waits for a move: a double-click must land on the edge.
 */
export function SidebarResizeHandle({
	controls,
	width,
	maxWidth,
	folded,
	isResizing,
	isDragging,
	onPointerDown,
	onDoubleClick,
	onKeyDown,
	onKeyUp,
}: SidebarResizeHandleProps) {
	const { t } = useTranslation("navigation");
	return (
		<>
			<hr
				aria-orientation="vertical"
				aria-controls={controls}
				aria-label={t("resize.label")}
				aria-valuemin={SIDEBAR_RAIL_WIDTH}
				aria-valuemax={maxWidth}
				aria-valuenow={width}
				aria-valuetext={folded ? t("resize.folded") : t("resize.width", { width })}
				tabIndex={0}
				title={t("resize.hint")}
				data-resizing={isResizing}
				data-testid="sidebar-resize-handle"
				onPointerDown={onPointerDown}
				onDoubleClick={onDoubleClick}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				className="peer absolute inset-y-0 -right-1.5 z-50 m-0 h-full w-3 cursor-col-resize touch-none select-none border-0 bg-transparent outline-none"
			/>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-y-0 right-0 z-50 w-0.5 translate-x-1/2 bg-transparent transition-colors delay-75",
					"peer-hover:bg-primary/50 peer-focus-visible:bg-primary",
					isResizing && "bg-primary delay-0",
				)}
			/>
			<span
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute top-1/2 right-0 z-50 h-9 w-1.5 translate-x-1/2 -translate-y-1/2 rounded-full",
					"border border-border bg-background opacity-0 shadow-sm transition-opacity delay-75",
					"peer-hover:border-primary peer-hover:opacity-100",
					"peer-focus-visible:border-primary peer-focus-visible:opacity-100",
					isResizing && "border-primary bg-primary opacity-100 delay-0",
				)}
			/>
			{isDragging && (
				<div aria-hidden="true" className="fixed inset-0 z-[60] cursor-col-resize" />
			)}
		</>
	);
}
