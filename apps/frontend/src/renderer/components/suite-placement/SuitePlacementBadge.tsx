import { CircleCheck, CircleX, Clock, CloudUpload, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

type Shown = "queued" | "sent" | "pending" | "passed" | "failed" | "not_started";

const TONE: Record<Shown, string> = {
	queued: "bg-muted text-muted-foreground border-border",
	sent: "bg-info/10 text-info border-info/30",
	pending: "bg-info/10 text-info border-info/30",
	passed: "bg-success/10 text-success border-success/30",
	failed: "bg-destructive/10 text-destructive border-destructive/30",
	not_started: "bg-warning/10 text-warning border-warning/30",
};

const ICON = {
	queued: Clock,
	sent: CloudUpload,
	pending: Clock,
	passed: CircleCheck,
	failed: CircleX,
	not_started: TriangleAlert,
} as const;

/** What the card says about its full suite, or null when it ran here as usual. */
export function shownSuiteState(task: Pick<Task, "ciSuite" | "suitePlacement">): Shown | null {
	if (task.ciSuite) return task.ciSuite.state;
	const target = task.suitePlacement?.target;
	if (target === "queue") return "queued";
	if (target === "ci" || target === "server") return "sent";
	return null;
}

/**
 * Where the card's full suite runs when it is not simply here: waiting its
 * turn on the machine, sent to the CI or the server, then the CI's verdict
 * on the pushed commit. The reason the backend gave is on hover.
 */
export function SuitePlacementBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const shown = shownSuiteState(task);
	if (!shown) return null;
	const Icon = ICON[shown];
	const placement = task.suitePlacement;
	const reason = placement
		? t(`tasks:suitePlacement.reasons.${placement.reason}`, {
				defaultValue: "",
				short: placement.short.map((s) => t(`tasks:suitePlacement.short.${s}`)).join(", "),
			})
		: "";
	const why = task.ciSuite?.reason
		? t(`tasks:suitePlacement.notStarted.${task.ciSuite.reason}`, { defaultValue: "" })
		: "";
	const title = [reason, why].filter(Boolean).join("\n") || undefined;
	return (
		<Badge
			variant="outline"
			className={cn("text-3xs px-1.5 py-0.5 flex items-center gap-1", TONE[shown])}
			title={title}
		>
			<Icon className="h-2.5 w-2.5" />
			{t(`tasks:suitePlacement.badge.${shown}`, {
				target: t(`tasks:suitePlacement.targets.${placement?.target ?? "ci"}`),
			})}
		</Badge>
	);
}
