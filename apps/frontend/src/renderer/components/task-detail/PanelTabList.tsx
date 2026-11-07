import { Gauge, ListChecks, ShieldCheck, type LucideIcon } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
	PANEL_SECTIONS,
	type PanelSectionId,
	panelTabDomId,
	panelTabPanelDomId,
} from "./panel-sections";

const ICONS: Record<PanelSectionId, LucideIcon> = {
	progress: ListChecks,
	quality: ShieldCheck,
	costs: Gauge,
};

interface PanelTabListProps {
	readonly taskId: string;
	readonly active: PanelSectionId;
	readonly onSelect: (section: PanelSectionId) => void;
	/** Decisions waiting in a tab, shown as a count on its tab. */
	readonly badges?: Partial<Record<PanelSectionId, number>>;
}

/**
 * The three tabs of the Overview, as the WAI-ARIA tabs pattern has them: one
 * tab in the Tab order (the selected one), arrows to move between tabs,
 * Home and End to reach the first and last; a tab is selected as it gets the
 * focus. Written by hand rather than with the Radix tabs of the panel: the
 * three panels must stay mounted (see `TaskOverview`).
 */
export function PanelTabList({ taskId, active, onSelect, badges }: PanelTabListProps) {
	const { t } = useTranslation(["tasks"]);
	const refs = useRef<Partial<Record<PanelSectionId, HTMLButtonElement | null>>>({});

	const move = (event: KeyboardEvent<HTMLButtonElement>) => {
		const at = PANEL_SECTIONS.indexOf(active);
		const last = PANEL_SECTIONS.length - 1;
		const next =
			event.key === "ArrowRight"
				? (at + 1) % PANEL_SECTIONS.length
				: event.key === "ArrowLeft"
					? (at + last) % PANEL_SECTIONS.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: null;
		if (next === null) return;
		event.preventDefault();
		const id = PANEL_SECTIONS[next];
		onSelect(id);
		refs.current[id]?.focus();
	};

	return (
		<div
			role="tablist"
			aria-label={t("tasks:panel.tabsLabel")}
			className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/60 bg-background/40 px-5 py-2.5"
		>
			{PANEL_SECTIONS.map((id) => {
				const Icon = ICONS[id];
				const selected = id === active;
				const badge = badges?.[id] ?? 0;
				return (
					<button
						key={id}
						ref={(node) => {
							refs.current[id] = node;
						}}
						type="button"
						role="tab"
						id={panelTabDomId(taskId, id)}
						aria-selected={selected}
						aria-controls={panelTabPanelDomId(taskId, id)}
						tabIndex={selected ? 0 : -1}
						onClick={() => onSelect(id)}
						onKeyDown={move}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
							"outline-none focus-visible:ring-2 focus-visible:ring-ring",
							selected
								? "border-primary/50 bg-primary/10 text-foreground"
								: "border-border bg-card/60 text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
					>
						<Icon className="h-3.5 w-3.5" aria-hidden />
						{t(`tasks:panel.sections.${id}.title`)}
						{badge > 0 && (
							<span className="rounded-full bg-warning px-1.5 text-3xs font-semibold leading-4 text-warning-foreground">
								<span aria-hidden>{badge}</span>
								<span className="sr-only">
									{t("tasks:panel.pendingDecisions", { count: badge })}
								</span>
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
