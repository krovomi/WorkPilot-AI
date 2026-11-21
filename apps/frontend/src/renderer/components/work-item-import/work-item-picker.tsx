/**
 * Picking work items from a tracker list: search, type and state filters,
 * selection, and the rows themselves. The import side panels (which drag the
 * picked items onto the board) and the Azure DevOps import dialog (which
 * imports them) share it.
 */
import { Check, GripVertical, RefreshCw, Search } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";

export interface PanelWorkItem {
	readonly id: string | number;
	readonly title: string;
	readonly description?: string;
	readonly state: string;
	readonly workItemType: string;
	readonly tags: string[];
}

const ALL = "all";
const sorted = (values: Iterable<string>) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));

export interface WorkItemPicker<T extends PanelWorkItem> {
	readonly query: string;
	readonly setQuery: (query: string) => void;
	/** The search without its surrounding spaces. */
	readonly trimmed: string;
	readonly type: string;
	readonly setType: (type: string) => void;
	readonly state: string;
	readonly setState: (state: string) => void;
	readonly types: string[];
	readonly states: string[];
	/** True when a search or a filter hides part of the list. */
	readonly narrowed: boolean;
	readonly filtered: T[];
	readonly selectedIds: ReadonlySet<T["id"]>;
	readonly selectedItems: T[];
	/** How many of the shown rows are selected. */
	readonly selectedShown: number;
	readonly allChecked: boolean | "indeterminate";
	readonly toggle: (id: T["id"]) => void;
	/** Selects every shown row, or none when they all are. */
	readonly toggleAll: () => void;
	/** Back to an empty search, no filter and no selection. */
	readonly reset: () => void;
}

export function useWorkItemPicker<T extends PanelWorkItem>(items: T[]): WorkItemPicker<T> {
	const [query, setQuery] = useState("");
	const [type, setType] = useState(ALL);
	const [state, setState] = useState(ALL);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<T["id"]>>(new Set());
	const trimmed = query.trim();

	const filtered = useMemo(() => {
		const needle = trimmed.toLowerCase();
		return items.filter(
			(item) =>
				(!needle ||
					item.title.toLowerCase().includes(needle) ||
					String(item.id).toLowerCase().includes(needle) ||
					!!item.description?.toLowerCase().includes(needle)) &&
				(type === ALL || item.workItemType === type) &&
				(state === ALL || item.state === state),
		);
	}, [items, trimmed, type, state]);
	const types = useMemo(() => sorted(items.map((item) => item.workItemType)), [items]);
	const states = useMemo(() => sorted(items.map((item) => item.state)), [items]);
	const selectedShown = filtered.filter((item) => selectedIds.has(item.id)).length;
	const allChecked = selectedShown === 0 ? false : selectedShown === filtered.length || "indeterminate";

	return {
		query,
		setQuery,
		trimmed,
		type,
		setType,
		state,
		setState,
		types,
		states,
		narrowed: !!trimmed || type !== ALL || state !== ALL,
		filtered,
		selectedIds,
		selectedItems: items.filter((item) => selectedIds.has(item.id)),
		selectedShown,
		allChecked,
		toggle: (id) =>
			setSelectedIds((prev) => {
				const next = new Set(prev);
				if (!next.delete(id)) next.add(id);
				return next;
			}),
		toggleAll: () => setSelectedIds(allChecked === true ? new Set() : new Set(filtered.map((item) => item.id))),
		reset: () => {
			setQuery("");
			setType(ALL);
			setState(ALL);
			setSelectedIds(new Set());
		},
	};
}

export interface PickerFilterLabels {
	readonly search: string;
	readonly type: string;
	readonly allTypes: string;
	readonly state: string;
	readonly allStates: string;
	readonly selection: (selected: number, total: number) => string;
}

interface PickerFiltersProps<T extends PanelWorkItem> {
	/** Makes the filter ids unique on the page. */
	readonly idPrefix: string;
	readonly picker: WorkItemPicker<T>;
	readonly labels: PickerFilterLabels;
	readonly loading: boolean;
	readonly refreshing: boolean;
	readonly onRefresh: () => void;
}

export function PickerFilters<T extends PanelWorkItem>({
	idPrefix,
	picker,
	labels,
	loading,
	refreshing,
	onRefresh,
}: PickerFiltersProps<T>) {
	const { t } = useTranslation("common");
	const refresh = t("buttons.refresh");
	const busy = loading || refreshing;
	return (
		<>
			<div className="relative">
				<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
				<Input
					placeholder={labels.search}
					aria-label={labels.search}
					value={picker.query}
					onChange={(e) => picker.setQuery(e.target.value)}
					className="pl-10"
				/>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div>
					<Label htmlFor={`${idPrefix}-type-filter`} className="text-xs text-foreground/70 mb-1 block">
						{labels.type}
					</Label>
					<NativeSelect
						id={`${idPrefix}-type-filter`}
						className="w-full"
						value={picker.type}
						onChange={(e) => picker.setType(e.target.value)}
					>
						<option value={ALL}>{labels.allTypes}</option>
						{picker.types.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</NativeSelect>
				</div>
				<div>
					<Label htmlFor={`${idPrefix}-state-filter`} className="text-xs text-foreground/70 mb-1 block">
						{labels.state}
					</Label>
					<NativeSelect
						id={`${idPrefix}-state-filter`}
						className="w-full"
						value={picker.state}
						onChange={(e) => picker.setState(e.target.value)}
					>
						<option value={ALL}>{labels.allStates}</option>
						{picker.states.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</NativeSelect>
				</div>
			</div>

			{picker.filtered.length > 0 && (
				<div className="flex items-center justify-between py-2">
					<div className="flex items-center gap-2">
						<Checkbox
							checked={picker.allChecked}
							onCheckedChange={picker.toggleAll}
							aria-label={t("accessibility.selectAllAriaLabel")}
						/>
						<span className="text-sm text-foreground/70">
							{labels.selection(picker.selectedShown, picker.filtered.length)}
						</span>
					</div>
					<Button variant="ghost" size="sm" onClick={onRefresh} disabled={busy} title={refresh} aria-label={refresh}>
						<RefreshCw className={cn("h-4 w-4", busy && "animate-spin", refreshing && "text-primary")} />
					</Button>
				</div>
			)}
		</>
	);
}

export interface PickerListLabels {
	/** Shown while a lookup of an item outside the list runs. */
	readonly searching?: string;
	readonly empty: string;
	readonly emptyFiltered: string;
}

interface PickerListProps<T extends PanelWorkItem> {
	readonly picker: WorkItemPicker<T>;
	readonly loading: boolean;
	/** A lookup of an item outside the list is running. */
	readonly searching?: boolean;
	readonly labels: PickerListLabels;
	readonly renderRow: (item: T) => React.ReactNode;
}

export function PickerList<T extends PanelWorkItem>({
	picker,
	loading,
	searching = false,
	labels,
	renderRow,
}: PickerListProps<T>) {
	if (loading) {
		return (
			<div className="flex items-center justify-center py-12">
				<RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
			</div>
		);
	}
	if (picker.filtered.length === 0) {
		return (
			<div className="text-center py-12 text-muted-foreground px-4">
				{searching ? (
					<div className="flex items-center justify-center gap-2">
						<RefreshCw className="h-4 w-4 animate-spin" />
						<span>{labels.searching}</span>
					</div>
				) : (
					<>
						<p>{labels.empty}</p>
						{picker.narrowed && <p className="text-sm mt-2">{labels.emptyFiltered}</p>}
					</>
				)}
			</div>
		);
	}
	return (
		<ul className="space-y-2">
			{picker.filtered.map((item) => (
				<li key={item.id}>{renderRow(item)}</li>
			))}
		</ul>
	);
}

interface PickerRowProps<T extends PanelWorkItem> {
	readonly item: T;
	readonly displayId: string;
	readonly selected: boolean;
	readonly onToggle: () => void;
	readonly typeColor: (type: string) => string;
	/** Badges after the type and state (priority, repository…). */
	readonly badges?: React.ReactNode;
	/** A line under the description (assignee…). */
	readonly details?: React.ReactNode;
	/** Rows that can be dragged onto the board. */
	readonly drag?: {
		readonly active: boolean;
		readonly onDragStart: (event: React.DragEvent<HTMLElement>) => void;
		readonly onDragEnd: () => void;
	};
}

/** A row is a toggle button: pressing it selects the item, its text names it. */
export function PickerRow<T extends PanelWorkItem>({
	item,
	displayId,
	selected,
	onToggle,
	typeColor,
	badges,
	details,
	drag,
}: PickerRowProps<T>) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			className={cn(
				"flex w-full items-start gap-3 p-3 rounded-md border text-left transition-all select-none",
				"hover:bg-muted/50",
				selected && "bg-primary/10 border-primary/30",
				selected && drag && "cursor-grab",
				drag?.active && "cursor-grabbing opacity-70 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md",
			)}
			draggable={!!drag}
			onClick={onToggle}
			onDragStart={drag?.onDragStart}
			onDragEnd={drag?.onDragEnd}
		>
			<span
				className={cn(
					"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
					selected && "bg-primary text-primary-foreground",
				)}
			>
				{selected && <Check className="h-3 w-3" />}
			</span>
			{selected && drag && <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />}
			<span className="flex-1 min-w-0">
				<span className="flex items-center gap-2 mb-1 flex-wrap">
					<span className="font-mono text-xs text-muted-foreground">{displayId}</span>
					<span className={cn(badgeVariants({ variant: "outline" }), typeColor(item.workItemType))}>
						{item.workItemType}
					</span>
					<span className={badgeVariants({ variant: "outline" })}>{item.state}</span>
					{badges}
				</span>
				<span className="block font-medium text-sm mb-1 truncate">{item.title}</span>
				{item.description && (
					<span className="block text-xs text-muted-foreground line-clamp-2">{item.description}</span>
				)}
				{details}
				{item.tags.length > 0 && (
					<span className="flex flex-wrap gap-1 mt-2">
						{item.tags.slice(0, 3).map((tag) => (
							<span key={tag} className={badgeVariants({ variant: "secondary" })}>
								{tag}
							</span>
						))}
						{item.tags.length > 3 && (
							<span className={badgeVariants({ variant: "secondary" })}>{`+${item.tags.length - 3}`}</span>
						)}
					</span>
				)}
			</span>
		</button>
	);
}
