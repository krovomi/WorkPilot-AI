import { FileWarning, Scissors } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	splitChildCount,
	splitGroupId,
	splitGroupTone,
	splitPartOf,
} from "../../../shared/utils/task-split";
import { cn } from "../../lib/utils";
import { useKanbanFilterStore } from "../../stores/kanban-filter-store";
import { toneClass } from "../charter";
import { Badge, badgeVariants } from "../ui/badge";

/** The group's colour on a badge: its charter tone, read from `--wp-tone`. */
const TONED: React.CSSProperties = {
	color: "var(--wp-tone)",
	borderColor: "color-mix(in srgb, var(--wp-tone) 45%, transparent)",
	background: "color-mix(in srgb, var(--wp-tone) 10%, transparent)",
};

/**
 * Where a card stands in an automatic split (`apps/backend/task_split/`):
 * « Partie 2/4 · OAuth » on a part, in its group's colour (the same on every
 * card of the group, on the phone and on the forge label), with the task it
 * came from on hover; « Découpée en 4 tâches » on the task that was split (in
 * the archive). Always written out, so the colour is never the only sign.
 * A click on a part's badge shows only its group on the board, a second
 * click shows everything again.
 */
export function SplitPartBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation("tasks");
	const group = splitGroupId(task);
	const active = useKanbanFilterStore((s) => Boolean(group) && s.filters.group === group);
	const toggleGroup = useKanbanFilterStore((s) => s.toggleGroup);
	if (!group) return null;
	const tone = toneClass(splitGroupTone(group));
	const part = splitPartOf(task);
	if (part) {
		return (
			<button
				type="button"
				aria-pressed={active}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					toggleGroup(group);
				}}
				title={`${t("split.partTooltip", {
					index: part.index,
					total: part.total,
					title: part.title,
					name: part.name ?? "",
				})}\n${t(active ? "split.showAll" : "split.showGroup")}`}
				className={cn(
					badgeVariants({ variant: "outline" }),
					"wp-scope",
					tone,
					"text-3xs px-1.5 py-0 flex w-fit max-w-56 items-center gap-1 cursor-pointer",
					active && "ring-1 ring-current",
				)}
				style={TONED}
			>
				<Scissors className="h-2.5 w-2.5 shrink-0" aria-hidden />
				<span className="truncate">
					{t("split.groupBadge", {
						index: part.index,
						total: part.total,
						title: part.title,
					})}
				</span>
			</button>
		);
	}
	const count = splitChildCount(task);
	return (
		<Badge
			variant="outline"
			className={cn("wp-scope", tone, "text-3xs px-1.5 py-0 flex w-fit items-center gap-1")}
			style={TONED}
			title={t("split.parentTooltip", {
				count,
				lines: task.metadata?.splitGroup?.maxLines ?? "",
			})}
		>
			<Scissors className="h-2.5 w-2.5" aria-hidden />
			{t("split.parentBadge", { count })}
		</Badge>
	);
}

/**
 * A finished branch with more lines to review than its kind of task allows
 * (`task_split/diff_check.py`, run after QA): « 620 / 400 lignes ». Shown
 * only above the ceiling, so a card in its limits stays as it was.
 */
export function ReviewLoadBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation("tasks");
	const check = task.metadata?.splitCheck;
	if (!check?.over) return null;
	return (
		<Badge
			variant="outline"
			className="text-3xs px-1.5 py-0 flex w-fit items-center gap-1 bg-warning/10 text-warning border-warning/30"
			title={t("split.overTooltip", {
				lines: check.lines,
				files: check.files,
				max: check.maxLines,
				maxFiles: check.maxFiles,
			})}
		>
			<FileWarning className="h-2.5 w-2.5" aria-hidden />
			{check.lines > check.maxLines
				? t("split.overBadge", { lines: check.lines, max: check.maxLines })
				: t("split.overFilesBadge", {
						files: check.files,
						max: check.maxFiles,
					})}
		</Badge>
	);
}
