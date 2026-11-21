/**
 * The side panel that imports work items from a tracker (Jira, Azure DevOps)
 * by dragging them onto a Kanban column. Each tracker gives its source of
 * items, its labels and how an item reads; the panel does the rest: search
 * (with a direct lookup by key), type and state filters, selection, dragging,
 * resizing and collapsing.
 */
import { ChevronLeft, ChevronRight, Download, Settings, X } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IPCResult } from "../../../shared/types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { endItemDrag, type PanelKind, startItemDrag } from "./drag";
import { useDirectLookup } from "./use-direct-lookup";
import { useSidePanelLayout } from "./use-side-panel-layout";
import type { SourceStatus, WorkItemSource } from "./use-work-item-source";
import {
	type PanelWorkItem,
	type PickerFilterLabels,
	PickerFilters,
	PickerList,
	type PickerListLabels,
	PickerRow,
	useWorkItemPicker,
} from "./work-item-picker";

export type { PanelWorkItem } from "./work-item-picker";

export interface PanelLabels extends PickerFilterLabels, PickerListLabels {
	readonly ariaLabel: string;
	readonly dragHint: string;
	readonly selected: (count: number) => string;
	readonly more: (count: number) => string;
	readonly configure: string;
	readonly resize: string;
}

interface WorkItemSidePanelProps<T extends PanelWorkItem, K> {
	readonly kind: PanelKind;
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onOpenSettings?: () => void;
	readonly source: WorkItemSource<T, SourceStatus>;
	readonly title: string;
	/** What the panel is connected to, under the header. */
	readonly info?: React.ReactNode;
	readonly labels: PanelLabels;
	/** The key to look up for a search, or null when the search names no item or a loaded one. */
	readonly lookupKey: (query: string, items: readonly T[]) => K | null;
	readonly fetchItem: (key: K) => Promise<IPCResult<T>>;
	readonly formatId: (item: T) => string;
	readonly typeColor: (type: string) => string;
	/** Badges after the type and state (priority, repository…). */
	readonly renderBadges?: (item: T) => React.ReactNode;
	/** A line under the description (assignee…). */
	readonly renderDetails?: (item: T) => React.ReactNode;
}

const sameId = (a: PanelWorkItem, b: PanelWorkItem) => a.id === b.id;

export function WorkItemSidePanel<T extends PanelWorkItem, K>({
	kind,
	projectId,
	open,
	onOpenChange,
	onOpenSettings,
	source,
	title,
	info,
	labels,
	lookupKey,
	fetchItem,
	formatId,
	typeColor,
	renderBadges,
	renderDetails,
}: WorkItemSidePanelProps<T, K>) {
	const { t } = useTranslation("common");
	const layout = useSidePanelLayout(`${kind}-panel-width-${projectId}`, open, onOpenChange);
	const { items, status, error, loading, refreshing } = source;
	const picker = useWorkItemPicker(items);
	const [draggedIds, setDraggedIds] = useState<ReadonlySet<T["id"]>>(new Set());
	const ghost = useRef<HTMLElement | null>(null);

	const searching = useDirectLookup(
		picker.trimmed && status?.connected ? lookupKey(picker.trimmed, items) : null,
		fetchItem,
		(item) => source.addItem(item, sameId),
	);

	const { selectedIds } = picker;
	const handleDragStart = useCallback(
		(event: React.DragEvent<HTMLElement>, item: T) => {
			const ids = selectedIds.has(item.id) ? [...selectedIds] : [item.id];
			setDraggedIds(new Set(ids));
			ghost.current = startItemDrag(
				event,
				kind,
				items.filter((candidate) => ids.includes(candidate.id)),
			);
		},
		[items, kind, selectedIds],
	);

	const handleDragEnd = useCallback(() => {
		setDraggedIds(new Set());
		endItemDrag(kind, ghost.current);
		ghost.current = null;
	}, [kind]);

	if (!open) return null;

	const collapseLabel = layout.collapsed ? t("accessibility.expandAriaLabel") : t("accessibility.collapseAriaLabel");
	const { selectedItems } = picker;

	return (
		<section
			ref={layout.panelRef}
			className="fixed right-0 top-0 h-full bg-background border-l border-border shadow-2xl flex flex-col z-300"
			style={{ width: `${layout.width}px` }}
			data-side-panel={kind}
			aria-label={labels.ariaLabel}
		>
			<div className="flex items-center justify-between p-4 border-b border-border">
				<div className="flex items-center gap-2 min-w-0">
					<Download className="h-5 w-5 text-primary shrink-0" />
					<h2 className="text-lg font-semibold truncate">{title}</h2>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						onClick={layout.toggleCollapse}
						className="h-7 w-7"
						title={collapseLabel}
						aria-label={collapseLabel}
					>
						{layout.collapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => onOpenChange(false)}
						aria-label={t("buttons.close")}
						title={t("buttons.close")}
					>
						<X className="h-4 w-4" />
					</Button>
				</div>
			</div>

			{info && <div className="px-4 py-2 bg-muted/50 border-b border-border text-sm text-foreground/70">{info}</div>}

			{error && (
				<div className="mx-4 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md" role="alert">
					<p className="text-sm text-destructive mb-3">{error}</p>
					{onOpenSettings && (
						<Button variant="outline" size="sm" onClick={onOpenSettings} className="gap-2">
							<Settings className="h-4 w-4" />
							{labels.configure}
						</Button>
					)}
				</div>
			)}

			{status?.connected && (
				<div className="p-4 space-y-4 border-b border-border">
					<PickerFilters
						idPrefix={kind}
						picker={picker}
						labels={labels}
						loading={loading}
						refreshing={refreshing}
						onRefresh={() => {
							picker.reset();
							void source.refresh();
						}}
					/>
				</div>
			)}

			<ScrollArea className="flex-1">
				<div className="p-4">
					<PickerList
						picker={picker}
						loading={loading}
						searching={searching}
						labels={labels}
						renderRow={(item) => (
							<PickerRow
								item={item}
								displayId={formatId(item)}
								selected={selectedIds.has(item.id)}
								onToggle={() => picker.toggle(item.id)}
								typeColor={typeColor}
								badges={renderBadges?.(item)}
								details={renderDetails?.(item)}
								drag={{
									active: draggedIds.has(item.id),
									onDragStart: (event) => handleDragStart(event, item),
									onDragEnd: handleDragEnd,
								}}
							/>
						)}
					/>
				</div>
			</ScrollArea>

			{selectedItems.length > 0 && (
				<div className="p-4 border-t border-border space-y-3">
					<div className="flex items-center gap-2 text-sm text-foreground/70">
						<Download className="h-4 w-4" />
						<span>{labels.dragHint}</span>
					</div>
					<div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
						{labels.selected(selectedItems.length)}
						<div className="mt-1 space-y-1">
							{selectedItems.slice(0, 3).map((item) => (
								<div key={item.id} className="flex items-center gap-2">
									<span className="font-mono">{formatId(item)}</span>
									<span className="truncate">{item.title}</span>
								</div>
							))}
							{selectedItems.length > 3 && <div>{labels.more(selectedItems.length - 3)}</div>}
						</div>
					</div>
				</div>
			)}

			<button
				type="button"
				className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 transition-colors border-0 bg-transparent p-0"
				onMouseDown={layout.startResize}
				title={labels.resize}
				aria-label={labels.resize}
			>
				<span className="absolute inset-y-0 -left-2 -right-2" />
			</button>
		</section>
	);
}
