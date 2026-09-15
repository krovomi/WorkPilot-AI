import { useTranslation } from "react-i18next";
import type { ActivityStatus, ViewBadge } from "@/stores/activity-store";
import { cn } from "@/lib/utils";

interface ActivityBadgeProps {
	/** Null renders nothing: silence is the default state of the sidebar. */
	badge: ViewBadge | null;
	/** True only for the one entry currently holding the animation slot. */
	attention?: boolean;
	/**
	 * `inline` sits at the end of a menu row; `corner` overlays the icon of a
	 * collapsed entry or group, where there is no room for a row.
	 */
	variant?: "inline" | "corner";
}

/**
 * The whole visual vocabulary of "this page has something for you", in one
 * place so it cannot drift between the expanded sidebar, the collapsed rail
 * and the group headers.
 *
 * Shape carries the meaning and colour only doubles it: a hollow ring is work
 * in progress, a filled dot is a result, a haloed dot is a failure. Colour
 * alone would be unreadable for a colour-blind user and unreliable across the
 * seven themes.
 */
export function ActivityBadge({
	badge,
	attention = false,
	variant = "inline",
}: ActivityBadgeProps) {
	const { t } = useTranslation(["navigation"]);

	if (!badge) return null;

	const { status, count, activity } = badge;

	// One job: name it. Several: count them — "Build — Refactor the parser"
	// answers what the badge is about, "3 jobs finished" answers how many, and
	// neither answers the other.
	const label =
		count === 1 && activity
			? [t(activity.labelKey), activity.label, activity.detail]
					.filter(Boolean)
					.join(" — ")
			: t(`navigation:activity.badge.${status}`, { count });

	return (
		<span
			// `img`, not `status`: a live region here would make a screen reader
			// announce every badge of a ~80-entry sidebar as it changes. The
			// announcement belongs to the activity centre; this is a graphic
			// with a name, read when the entry itself is read.
			role="img"
			aria-label={label}
			title={label}
			className={cn(
				"pointer-events-none flex shrink-0 items-center justify-center",
				TEXT_BY_STATUS[status],
				variant === "corner" &&
					"absolute -right-0.5 -top-0.5 rounded-full bg-sidebar p-[1px]",
			)}
		>
			<span
				className={cn(
					"block rounded-full",
					count > 1
						? "min-w-[14px] px-1 text-center font-mono text-[9px] font-semibold leading-[14px]"
						: "h-2 w-2",
					count > 1 ? FILLED_COUNT_BY_STATUS[status] : DOT_BY_STATUS[status],
					attention && "animate-activity-attention",
				)}
			>
				{count > 1 ? count : null}
			</span>
		</span>
	);
}

/** currentColor drives both the dot and the halo of the attention animation. */
const TEXT_BY_STATUS: Record<ActivityStatus, string> = {
	running: "text-muted-foreground/70",
	success: "text-primary",
	error: "text-destructive",
};

const DOT_BY_STATUS: Record<ActivityStatus, string> = {
	// Hollow: work in progress is ambient, not a result to act on.
	running: "border-[1.5px] border-current bg-transparent",
	success: "bg-current",
	error: "bg-current ring-2 ring-current/25",
};

const FILLED_COUNT_BY_STATUS: Record<ActivityStatus, string> = {
	running: "border-[1.5px] border-current",
	success: "bg-current text-primary-foreground",
	error: "bg-current text-destructive-foreground",
};
