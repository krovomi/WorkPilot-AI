import { AlertTriangle, Check, ChevronUp, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Activity } from "@/stores/activity-store";
import {
	selectRunning,
	selectUnseenFinished,
	useActivityStore,
} from "@/stores/activity-store";
import { navItemLabelKey } from "./Sidebar";

interface ActivityCentreProps {
	/** The page on screen: its own work is visible there, not here. */
	activeView: string;
	/** Jump to the page an activity belongs to, spotlighting it when it can. */
	onOpen: (activity: Activity) => void;
}

/**
 * The one place that answers "what is running, everywhere?" — the counterpart
 * of the sidebar badges, which answer "where?" but not "what".
 *
 * It replaces the Kanban-only running-tasks pill: agents were never the only
 * thing that kept working after the user left a page, they were only the only
 * thing that said so.
 */
export function ActivityCentre({ activeView, onOpen }: ActivityCentreProps) {
	const { t } = useTranslation(["common", "navigation"]);
	const [expanded, setExpanded] = useState(false);
	// Dismissal is per set of activities: something new starting brings the pill
	// back rather than hiding it for the rest of the session.
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);

	const activities = useActivityStore((state) => state.activities);

	// Work on the page in front of the user needs no floating reminder.
	const elsewhere = activities.filter((a) => a.view !== activeView);
	const running = selectRunning(elsewhere);
	const finished = selectUnseenFinished(elsewhere);
	const shown = [...running, ...finished];

	const key = shown
		.map((a) => `${a.id}:${a.status}`)
		.sort()
		.join("|");

	if (shown.length === 0 || key === dismissedKey) return null;

	const failed = finished.filter((a) => a.status === "error").length;

	// One line, in priority order: a failure outranks a count of successes,
	// which outranks "still working".
	const summary =
		failed > 0
			? t("activityCentre.failed", { count: failed })
			: running.length > 0
				? t("activityCentre.running", { count: running.length })
				: t("activityCentre.finished", { count: finished.length });

	return (
		<div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
			{expanded && (
				<ul className="w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
					{shown.map((activity) => (
						<li key={activity.id}>
							<button
								type="button"
								onClick={() => onOpen(activity)}
								className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent"
							>
								<ActivityIcon status={activity.status} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-foreground">
										{activity.label ?? t(activity.labelKey)}
									</span>
									<span className="block truncate text-[10px] text-muted-foreground">
										{pageName(t, activity)}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<div className="flex items-center gap-1 rounded-full border border-border bg-popover py-1 pl-3 pr-1 shadow-lg">
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					className="flex items-center gap-2 text-xs font-medium text-foreground"
				>
					{running.length > 0 ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
					) : (
						<ActivityIcon status={failed > 0 ? "error" : "success"} />
					)}
					{summary}
					<ChevronUp
						className={cn(
							"h-3.5 w-3.5 text-muted-foreground transition-transform",
							expanded && "rotate-180",
						)}
					/>
				</button>

				<button
					type="button"
					onClick={() => setDismissedKey(key)}
					aria-label={t("activityCentre.dismiss")}
					className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}

function ActivityIcon({ status }: { status: Activity["status"] }) {
	if (status === "running") {
		return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
	}
	if (status === "error") {
		return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
	}
	return <Check className="h-3.5 w-3.5 shrink-0 text-primary" />;
}

/** The menu entry's own name, so a row says where it will take you. */
function pageName(
	t: (key: string) => string,
	activity: Activity,
): string {
	const labelKey = navItemLabelKey(activity.view);
	return labelKey ? t(labelKey) : activity.view;
}
