import { FileWarning, Scissors } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { splitChildCount, splitPartOf } from "../../../shared/utils/task-split";
import { Badge } from "../ui/badge";

/**
 * Where a card stands in an automatic split (`apps/backend/task_split/`):
 * « Partie 2/4 » on a part, with the task it came from and what it builds on
 * hover; « Découpée en 4 tâches » on the task that was split (in the archive).
 * Always written out, so the card reads the same in every theme.
 */
export function SplitPartBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation("tasks");
	const part = splitPartOf(task);
	if (part) {
		return (
			<Badge
				variant="outline"
				className="text-3xs px-1.5 py-0 flex w-fit items-center gap-1 bg-muted/40 text-foreground border-border"
				title={t("split.partTooltip", {
					index: part.index,
					total: part.total,
					title: part.title,
					name: part.name ?? "",
				})}
			>
				<Scissors className="h-2.5 w-2.5" aria-hidden />
				{t("split.partBadge", { index: part.index, total: part.total })}
			</Badge>
		);
	}
	const count = splitChildCount(task);
	if (count === 0) return null;
	return (
		<Badge
			variant="outline"
			className="text-3xs px-1.5 py-0 flex w-fit items-center gap-1 bg-muted/40 text-muted-foreground border-border"
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
