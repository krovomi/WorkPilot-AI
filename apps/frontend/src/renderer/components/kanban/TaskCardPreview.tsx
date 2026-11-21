import { Ban, Clock, Cpu, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ResolvedCardType } from "../../../shared/constants/card-types";
import type { Task } from "../../../shared/types";
import { useFormatRelativeTime } from "../../hooks/useFormatRelativeTime";
import { getTaskSource } from "../../lib/kanban-filter";
import { sanitizeMarkdownForDisplay } from "../../lib/utils";
import { useKanbanBlockerStore } from "../../stores/kanban-blocker-store";
import { CardTypeChip } from "./CardTypeChip";

/** Room for a few sentences: the card itself clamps the description to two lines. */
const PREVIEW_DESCRIPTION_CHARS = 320;

interface TaskCardPreviewProps {
	task: Task;
	resolved: ResolvedCardType | null;
	/** The card's own status label (TaskCard decides it, the preview repeats it). */
	statusLabel: string;
}

/**
 * What a Kanban card shows after the pointer rests on it
 * (`hooks/useHoverPreview.ts`): the type and what decided it, the full
 * title, more of the description, the classification, the state (phase and
 * progress, or what blocks it), the origin, the engine and the last activity.
 * Rendered only while open, so a board of hundreds of cards pays nothing.
 */
export function TaskCardPreview({
	task,
	resolved,
	statusLabel,
}: TaskCardPreviewProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const formatRelativeTime = useFormatRelativeTime();
	const pending = useKanbanBlockerStore(
		(s) => s.blockers[task.id]?.pending ?? null,
	);
	const meta = task.metadata;
	const description = task.description
		? sanitizeMarkdownForDisplay(task.description, PREVIEW_DESCRIPTION_CHARS)
		: "";
	const field = (label: string, value: string) =>
		t("tasks:cardType.preview.field", { label, value });
	const classification = [
		meta?.priority &&
			field(
				t("tasks:form.classification.priority"),
				t(`tasks:form.classification.values.priority.${meta.priority}`),
			),
		meta?.complexity &&
			field(
				t("tasks:form.classification.complexity"),
				t(`tasks:form.classification.values.complexity.${meta.complexity}`),
			),
		meta?.impact &&
			t(`tasks:form.classification.values.impact.${meta.impact}`),
	].filter(Boolean) as string[];
	const progress = task.executionProgress?.overallProgress;
	const running =
		(task.status === "in_progress" || task.status === "ai_review") &&
		typeof progress === "number";
	const source = getTaskSource(task);
	const engine = [meta?.provider, meta?.model].filter(Boolean).join(" · ");

	return (
		<div className="w-72 max-w-[80vw] space-y-2 py-1 text-xs">
			{resolved && (
				<div className="flex flex-wrap items-center gap-2">
					<CardTypeChip resolved={resolved} />
					<span className="text-muted-foreground">
						{t(`tasks:cardType.basis.${resolved.basis}`)}
					</span>
				</div>
			)}
			<p className="text-sm font-semibold leading-snug text-foreground">
				{task.title}
			</p>
			{description && (
				<p className="leading-relaxed text-muted-foreground">{description}</p>
			)}
			{classification.length > 0 && (
				<p className="text-foreground/80">{classification.join(" · ")}</p>
			)}
			<div className="space-y-1 border-t border-border pt-2">
				<p className="font-medium text-foreground">
					{running
						? t("tasks:cardType.preview.progress", {
								status: statusLabel,
								percent: Math.round(progress),
							})
						: statusLabel}
				</p>
				{pending && pending.length > 0 && (
					<div className="flex items-start gap-1.5 text-warning">
						<Ban className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
						<span>
							{t("tasks:cardType.preview.blockedBy", {
								titles: pending.map((b) => b.title).join(", "),
							})}
						</span>
					</div>
				)}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
					<span className="inline-flex items-center gap-1">
						<GitBranch className="h-3 w-3" aria-hidden="true" />
						{t(`tasks:kanban.filter.sources.${source}`)}
					</span>
					{engine && (
						<span className="inline-flex items-center gap-1">
							<Cpu className="h-3 w-3" aria-hidden="true" />
							{engine}
						</span>
					)}
					<span className="inline-flex items-center gap-1">
						<Clock className="h-3 w-3" aria-hidden="true" />
						{formatRelativeTime(task.updatedAt)}
					</span>
				</div>
			</div>
		</div>
	);
}
