import {
	CaseSensitive,
	ChevronDown,
	ChevronUp,
	ListFilter,
	Regex,
	Search,
	WholeWord,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskLogPhase } from "../../../shared/types";
import {
	LOG_ENTRY_KINDS,
	type LogEntryKind,
	type LogSearchOptions,
} from "../../../shared/utils/task-logs-search";
import { cn } from "../../lib/utils";
import { Input } from "../ui";

export type LogSearchFlags = Required<Omit<LogSearchOptions, "query">>;

export const DEFAULT_SEARCH_FLAGS: LogSearchFlags = {
	caseSensitive: false,
	wholeWord: false,
	regex: false,
};

interface TaskLogsSearchBarProps {
	inputRef: React.RefObject<HTMLInputElement | null>;
	query: string;
	onQueryChange: (query: string) => void;
	flags: LogSearchFlags;
	onFlagsChange: (flags: LogSearchFlags) => void;
	/** The regular expression does not compile (shown instead of the count). */
	regexError: string | null;
	/** Whether a search or a filter narrows the list (counter + navigation). */
	isActive: boolean;
	/** Whether a text query is typed (counter reads "results", not "entries"). */
	isSearching: boolean;
	total: number;
	/** 0-based current match, -1 when none is selected yet. */
	current: number;
	onNext: () => void;
	onPrevious: () => void;
	phases: readonly TaskLogPhase[];
	phaseFilter: ReadonlySet<TaskLogPhase>;
	onTogglePhase: (phase: TaskLogPhase) => void;
	kindFilter: ReadonlySet<LogEntryKind>;
	onToggleKind: (kind: LogEntryKind) => void;
	/** Number of narrowed filter groups (0 = everything shown). */
	activeFilterCount: number;
	onResetFilters: () => void;
}

const ICON_BUTTON =
	"flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-40";

const TOGGLE_ON = "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary";

/**
 * Search box of the task logs: text query with case / whole word / regular
 * expression options, previous/next navigation with an "n/N" counter, and a
 * filter panel (phase, entry type).
 *
 * Keyboard, while the box has focus: Enter / Shift+Enter (or F3 / Shift+F3)
 * go to the next / previous match, Alt+C, Alt+W and Alt+R toggle the options,
 * Escape clears the query.
 */
export function TaskLogsSearchBar({
	inputRef,
	query,
	onQueryChange,
	flags,
	onFlagsChange,
	regexError,
	isActive,
	isSearching,
	total,
	current,
	onNext,
	onPrevious,
	phases,
	phaseFilter,
	onTogglePhase,
	kindFilter,
	onToggleKind,
	activeFilterCount,
	onResetFilters,
}: TaskLogsSearchBarProps) {
	const { t } = useTranslation(["tasks"]);
	const [filtersOpen, setFiltersOpen] = useState(false);

	const toggleFlag = (flag: keyof LogSearchFlags) =>
		onFlagsChange({ ...flags, [flag]: !flags[flag] });

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === "F3") {
			e.preventDefault();
			if (e.shiftKey) onPrevious();
			else onNext();
			return;
		}
		if (e.key === "Escape" && query) {
			e.preventDefault();
			e.stopPropagation();
			onQueryChange("");
			return;
		}
		if (e.altKey && !e.ctrlKey && !e.metaKey) {
			const flag = (
				{ c: "caseSensitive", w: "wholeWord", r: "regex" } as const
			)[e.code.replace(/^Key/, "").toLowerCase() as "c" | "w" | "r"];
			if (flag) {
				e.preventDefault();
				toggleFlag(flag);
			}
		}
	};

	const counter = regexError
		? t("tasks:logs.search.invalidRegex", "Expression invalide")
		: current >= 0
			? t("tasks:logs.search.position", "{{current}}/{{total}}", {
					current: current + 1,
					total,
				})
			: isSearching
				? t("tasks:logs.search.results", "{{count}} résultat(s)", {
						count: total,
					})
				: t("tasks:logs.search.entries", "{{count}} entrée(s)", {
						count: total,
					});

	const flagButtons: {
		flag: keyof LogSearchFlags;
		icon: typeof CaseSensitive;
		label: string;
	}[] = [
		{
			flag: "caseSensitive",
			icon: CaseSensitive,
			label: t("tasks:logs.search.caseSensitive", "Respecter la casse (Alt+C)"),
		},
		{
			flag: "wholeWord",
			icon: WholeWord,
			label: t("tasks:logs.search.wholeWord", "Mot entier (Alt+W)"),
		},
		{
			flag: "regex",
			icon: Regex,
			label: t("tasks:logs.search.regex", "Expression régulière (Alt+R)"),
		},
	];

	return (
		<div className="shrink-0 border-b border-border/50 p-2">
			<div className="flex items-center gap-1">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder={t(
							"tasks:logs.search.placeholder",
							"Rechercher dans les logs…",
						)}
						aria-label={t(
							"tasks:logs.search.ariaLabel",
							"Rechercher dans les logs",
						)}
						aria-invalid={regexError ? true : undefined}
						title={regexError ?? undefined}
						className={cn(
							"h-8 w-full pl-8 pr-[5.5rem] text-xs",
							regexError && "border-destructive focus-visible:ring-destructive/40",
						)}
					/>
					<div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
						{flagButtons.map(({ flag, icon: Icon, label }) => (
							<button
								key={flag}
								type="button"
								onClick={() => toggleFlag(flag)}
								aria-pressed={flags[flag]}
								aria-label={label}
								title={label}
								className={cn(ICON_BUTTON, flags[flag] && TOGGLE_ON)}
							>
								<Icon className="h-3.5 w-3.5" />
							</button>
						))}
					</div>
				</div>

				{isActive && (
					<span
						className={cn(
							"min-w-[3.5rem] shrink-0 text-center text-3xs tabular-nums",
							regexError ? "text-destructive" : "text-muted-foreground",
						)}
						aria-live="polite"
					>
						{counter}
					</span>
				)}
				<button
					type="button"
					onClick={onPrevious}
					disabled={!isActive || total === 0}
					aria-label={t(
						"tasks:logs.search.previous",
						"Résultat précédent (Maj+Entrée)",
					)}
					title={t("tasks:logs.search.previous", "Résultat précédent (Maj+Entrée)")}
					className={ICON_BUTTON}
				>
					<ChevronUp className="h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={onNext}
					disabled={!isActive || total === 0}
					aria-label={t("tasks:logs.search.next", "Résultat suivant (Entrée)")}
					title={t("tasks:logs.search.next", "Résultat suivant (Entrée)")}
					className={ICON_BUTTON}
				>
					<ChevronDown className="h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={() => setFiltersOpen((v) => !v)}
					aria-expanded={filtersOpen}
					aria-label={t("tasks:logs.search.filters", "Filtres")}
					title={t("tasks:logs.search.filters", "Filtres")}
					className={cn(
						ICON_BUTTON,
						"relative",
						(filtersOpen || activeFilterCount > 0) && TOGGLE_ON,
					)}
				>
					<ListFilter className="h-3.5 w-3.5" />
					{activeFilterCount > 0 && (
						<span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-3xs leading-none text-primary-foreground tabular-nums">
							{activeFilterCount}
						</span>
					)}
				</button>
				{query && (
					<button
						type="button"
						onClick={() => onQueryChange("")}
						aria-label={t("tasks:logs.search.clear", "Effacer la recherche")}
						title={t("tasks:logs.search.clear", "Effacer la recherche")}
						className={ICON_BUTTON}
					>
						<X className="h-3.5 w-3.5" />
					</button>
				)}
			</div>

			{filtersOpen && (
				<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs">
					<FilterGroup label={t("tasks:logs.search.filterPhase", "Phase")}>
						{phases.map((phase) => (
							<FilterChip
								key={phase}
								selected={phaseFilter.has(phase)}
								onClick={() => onTogglePhase(phase)}
							>
								{t(`tasks:execution.phases.${phase}`)}
							</FilterChip>
						))}
					</FilterGroup>
					<FilterGroup label={t("tasks:logs.search.filterKind", "Type")}>
						{LOG_ENTRY_KINDS.map((kind) => (
							<FilterChip
								key={kind}
								selected={kindFilter.has(kind)}
								onClick={() => onToggleKind(kind)}
							>
								{t(`tasks:logs.search.kinds.${kind}`)}
							</FilterChip>
						))}
					</FilterGroup>
					{activeFilterCount > 0 && (
						<button
							type="button"
							onClick={onResetFilters}
							className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
						>
							{t("tasks:logs.search.resetFilters", "Réinitialiser")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function FilterGroup({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
			<legend className="sr-only">{label}</legend>
			<span aria-hidden="true" className="mr-0.5 text-muted-foreground">
				{label}
			</span>
			{children}
		</fieldset>
	);
}

function FilterChip({
	selected,
	onClick,
	children,
}: {
	selected: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={selected}
			className={cn(
				"rounded-full border px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
				selected
					? "border-primary/40 bg-primary/10 text-foreground"
					: "border-border/60 text-muted-foreground line-through decoration-muted-foreground/50 hover:bg-secondary/60 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
