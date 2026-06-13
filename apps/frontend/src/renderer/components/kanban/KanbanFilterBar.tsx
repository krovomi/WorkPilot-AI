import {
	ArrowDownNarrowWide,
	ArrowUpNarrowWide,
	Filter,
	ListFilter,
	Search,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	TASK_CATEGORY_LABELS,
	TASK_PRIORITY_LABELS,
} from "../../../shared/constants";
import type { TaskCategory, TaskPriority } from "../../../shared/types";
import {
	activeFilterCount,
	hasActiveFilters,
	type TaskSortField,
	TASK_SOURCES,
	type TaskSource,
} from "../../lib/kanban-filter";
import { cn } from "../../lib/utils";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const CATEGORY_OPTIONS = Object.keys(TASK_CATEGORY_LABELS) as TaskCategory[];
const PRIORITY_OPTIONS = Object.keys(TASK_PRIORITY_LABELS) as TaskPriority[];
const SORT_FIELDS: TaskSortField[] = [
	"manual",
	"priority",
	"created",
	"updated",
	"title",
];

interface FilterCheckRowProps {
	label: string;
	checked: boolean;
	onToggle: () => void;
}

function FilterCheckRow({ label, checked, onToggle }: FilterCheckRowProps) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted/60 transition-colors"
		>
			<Checkbox checked={checked} className="h-4 w-4 pointer-events-none" />
			<span className="truncate">{label}</span>
		</button>
	);
}

/**
 * Filter + sort toolbar for the Kanban board. State is held in the
 * kanban-filter-store (persisted per project); this component is purely the UI.
 */
export function KanbanFilterBar() {
	const { t } = useTranslation(["tasks", "common"]);
	const filters = useKanbanFilterStore((s) => s.filters);
	const sort = useKanbanFilterStore((s) => s.sort);
	const setSearch = useKanbanFilterStore((s) => s.setSearch);
	const toggleSource = useKanbanFilterStore((s) => s.toggleSource);
	const toggleCategory = useKanbanFilterStore((s) => s.toggleCategory);
	const togglePriority = useKanbanFilterStore((s) => s.togglePriority);
	const setSortField = useKanbanFilterStore((s) => s.setSortField);
	const toggleSortDirection = useKanbanFilterStore((s) => s.toggleSortDirection);
	const clearFilters = useKanbanFilterStore((s) => s.clearFilters);

	const count = activeFilterCount(filters);
	const filtersActive = hasActiveFilters(filters);

	const sourceLabel = (source: TaskSource): string =>
		t(`kanban.filter.sources.${source}`);
	const sortFieldLabel = (field: TaskSortField): string =>
		t(`kanban.sort.fields.${field}`);

	return (
		<div className="flex items-center gap-2">
			{/* Search */}
			<div className="relative">
				<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
				<Input
					value={filters.search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t("kanban.filter.searchPlaceholder")}
					aria-label={t("kanban.filter.searchPlaceholder")}
					className="h-8 w-44 pl-7 pr-7 text-sm"
				/>
				{filters.search.length > 0 && (
					<button
						type="button"
						onClick={() => setSearch("")}
						aria-label={t("kanban.filter.clearSearch")}
						className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</div>

			{/* Filter popover */}
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							"h-8 gap-1.5 text-muted-foreground hover:text-foreground",
							filtersActive && "text-primary hover:text-primary",
						)}
					>
						<Filter className="h-4 w-4" />
						{t("kanban.filter.button")}
						{count > 0 && (
							<Badge
								variant="secondary"
								className="h-4 min-w-4 px-1 text-[10px] leading-none"
							>
								{count}
							</Badge>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-64 p-3">
					<div className="flex items-center justify-between pb-2">
						<span className="text-sm font-semibold">
							{t("kanban.filter.title")}
						</span>
						{filtersActive && (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
								onClick={clearFilters}
							>
								{t("kanban.filter.clear")}
							</Button>
						)}
					</div>

					<div className="max-h-[60vh] overflow-y-auto pr-1 space-y-3">
						{/* Source */}
						<div>
							<p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
								{t("kanban.filter.sourceLabel")}
							</p>
							{TASK_SOURCES.map((source) => (
								<FilterCheckRow
									key={source}
									label={sourceLabel(source)}
									checked={filters.sources.includes(source)}
									onToggle={() => toggleSource(source)}
								/>
							))}
						</div>

						{/* Category */}
						<div>
							<p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
								{t("kanban.filter.categoryLabel")}
							</p>
							{CATEGORY_OPTIONS.map((category) => (
								<FilterCheckRow
									key={category}
									label={TASK_CATEGORY_LABELS[category]}
									checked={filters.categories.includes(category)}
									onToggle={() => toggleCategory(category)}
								/>
							))}
						</div>

						{/* Priority */}
						<div>
							<p className="px-1.5 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
								{t("kanban.filter.priorityLabel")}
							</p>
							{PRIORITY_OPTIONS.map((priority) => (
								<FilterCheckRow
									key={priority}
									label={TASK_PRIORITY_LABELS[priority]}
									checked={filters.priorities.includes(priority)}
									onToggle={() => togglePriority(priority)}
								/>
							))}
						</div>
					</div>
				</PopoverContent>
			</Popover>

			{/* Sort */}
			<div className="flex items-center">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className={cn(
								"h-8 gap-1.5 text-muted-foreground hover:text-foreground",
								sort.field !== "manual" && "text-primary hover:text-primary",
							)}
						>
							<ListFilter className="h-4 w-4" />
							{sortFieldLabel(sort.field)}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuLabel>{t("kanban.sort.title")}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuRadioGroup
							value={sort.field}
							onValueChange={(v) => setSortField(v as TaskSortField)}
						>
							{SORT_FIELDS.map((field) => (
								<DropdownMenuRadioItem key={field} value={field}>
									{sortFieldLabel(field)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						{sort.field !== "manual" && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={toggleSortDirection}>
									{sort.direction === "asc" ? (
										<ArrowUpNarrowWide className="mr-2 h-4 w-4" />
									) : (
										<ArrowDownNarrowWide className="mr-2 h-4 w-4" />
									)}
									{sort.direction === "asc"
										? t("kanban.sort.ascending")
										: t("kanban.sort.descending")}
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
