/**
 * The pieces of a Kanban column's header band (« Bandeau » style): its icon,
 * its count, its capacity gauge and its empty state. Styles in
 * styles/kanban-columns.css, design in docs/architecture/kanban-columns.md.
 */
import {
	Bot,
	CircleCheck,
	GitPullRequest,
	Hourglass,
	Inbox,
	LoaderCircle,
	type LucideIcon,
	OctagonX,
	Plus,
	UserCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TaskStatus } from "../../../shared/types";
import type { PulseItem } from "../../lib/column-pulse";
import {
	type ColumnCapacity,
	MAX_GAUGE_SEGMENTS,
} from "../../lib/kanban-column-meta";
import { cn } from "../../lib/utils";

const COLUMN_ICONS: Partial<Record<TaskStatus, LucideIcon>> = {
	backlog: Inbox,
	queue: Hourglass,
	in_progress: LoaderCircle,
	ai_review: Bot,
	human_review: UserCheck,
	build_failed: OctagonX,
	pr_created: GitPullRequest,
	done: CircleCheck,
};

export function columnIcon(status: TaskStatus): LucideIcon {
	return COLUMN_ICONS[status] ?? Inbox;
}

/** The column's icon on a solid tile of its accent; it turns while agents work. */
export function ColumnIcon({ status, busy = false }: { status: TaskStatus; busy?: boolean }) {
	const Icon = columnIcon(status);
	return (
		<span className="kanban-col-icon" aria-hidden="true">
			<Icon className={cn(busy && "kanban-col-icon-busy")} />
		</span>
	);
}

/** The big count at the band's right; `n/limit` when the column has a limit. */
export function ColumnCount({
	count,
	capacity,
}: {
	count: number;
	capacity: ColumnCapacity | null;
}) {
	const { t } = useTranslation("tasks");
	if (!capacity) return <span className="kanban-col-count">{count}</span>;
	return (
		<span className="kanban-col-count" data-warn={capacity.warn ? "" : undefined}>
			<span aria-hidden="true">
				{count}
				<small>/{capacity.limit}</small>
			</span>
			<span className="sr-only">
				{t(
					capacity.kind === "slots"
						? "kanban.capacity.slotsAria"
						: "kanban.capacity.wipAria",
					{ count, limit: capacity.limit },
				)}
			</span>
		</span>
	);
}

/**
 * How full the column is: one segment per parallel task for « En cours »,
 * a bar for a WIP limit (or more slots than fit as segments).
 */
/** The one-line summary under the column title (lib/column-pulse.ts). */
export function ColumnPulse({ items }: { items: PulseItem[] }) {
	const { t } = useTranslation("tasks");
	if (items.length === 0) return null;
	const text = items.map((item) => t(`kanban.pulse.${item.key}`, item.values));
	return (
		<p
			className="kanban-col-pulse"
			role="note"
			aria-label={t("kanban.pulse.label")}
			title={text.join(" · ")}
		>
			{items.map((item, i) => (
				<span key={item.key} data-warn={item.warn ? "" : undefined}>
					{text[i]}
				</span>
			))}
		</p>
	);
}

export function ColumnGauge({
	count,
	capacity,
}: {
	count: number;
	capacity: ColumnCapacity;
}) {
	const { t } = useTranslation("tasks");
	const segmented = capacity.kind === "slots" && capacity.limit <= MAX_GAUGE_SEGMENTS;
	const slots = Array.from({ length: segmented ? capacity.limit : 0 }, (_, i) => ({
		id: `slot-${i + 1}`,
		on: i < count,
	}));
	return (
		<div
			className="kanban-col-gauge"
			data-warn={capacity.warn ? "" : undefined}
			aria-hidden="true"
		>
			{segmented ? (
				slots.map((slot) => (
					<span
						key={slot.id}
						className="kanban-col-gauge-seg"
						data-on={slot.on ? "" : undefined}
					/>
				))
			) : (
				<span className="kanban-col-gauge-bar">
					<span style={{ width: `${capacity.fill}%` }} />
				</span>
			)}
			<span className="kanban-col-gauge-label">
				{t(
					capacity.kind === "slots"
						? "kanban.capacity.slots"
						: "kanban.capacity.wip",
					{ count, limit: capacity.limit },
				)}
			</span>
		</div>
	);
}

// Empty state content for each column
export const getEmptyStateContent = (
	status: TaskStatus,
	t: (key: string) => string,
): { icon: ReactNode; message: string; subtext?: string } => {
	// An empty « Build rouge » is good news: it shows a check, not its own icon.
	const Icon = status === "build_failed" ? CircleCheck : columnIcon(status);
	const icon = <Icon className="h-5 w-5" />;
	switch (status) {
		case "backlog":
			return { icon, message: t("kanban.emptyBacklog"), subtext: t("kanban.emptyBacklogHint") };
		case "queue":
			return { icon, message: t("kanban.emptyQueue"), subtext: t("kanban.emptyQueueHint") };
		case "in_progress":
			return { icon, message: t("kanban.emptyInProgress"), subtext: t("kanban.emptyInProgressHint") };
		case "ai_review":
			return { icon, message: t("kanban.emptyAiReview"), subtext: t("kanban.emptyAiReviewHint") };
		case "human_review":
			return { icon, message: t("kanban.emptyHumanReview"), subtext: t("kanban.emptyHumanReviewHint") };
		case "build_failed":
			return { icon, message: t("kanban.emptyBuildFailed"), subtext: t("kanban.emptyBuildFailedHint") };
		case "pr_created":
			return { icon, message: t("kanban.emptyPrOpen"), subtext: t("kanban.emptyPrOpenHint") };
		case "done":
			return { icon, message: t("kanban.emptyDone"), subtext: t("kanban.emptyDoneHint") };
		default:
			return { icon, message: t("kanban.emptyDefault") };
	}
};

/** An empty column: its icon in a halo of its accent, or the drop invitation. */
export function ColumnEmptyState({ status, isOver }: { status: TaskStatus; isOver: boolean }) {
	const { t } = useTranslation(["tasks", "common"]);
	const empty = getEmptyStateContent(status, t);
	return (
		<div className={cn("empty-column-dropzone kanban-col-empty", isOver && "active")}>
			<span className="kanban-col-empty-icon" aria-hidden="true">
				{isOver ? <Plus className="h-5 w-5" /> : empty.icon}
			</span>
			{isOver ? (
				<span className="kanban-col-empty-title">{t("kanban.dropHere")}</span>
			) : (
				<>
					<span className="kanban-col-empty-title">{empty.message}</span>
					{empty.subtext && (
						<span className="kanban-col-empty-hint">{empty.subtext}</span>
					)}
				</>
			)}
		</div>
	);
}
