import { Tag } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	TASK_KINDS,
	type Task,
	type TaskKind,
} from "../../../shared/types/task";
import { useToast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { persistUpdateTask } from "../../stores/task-store";
import { Badge } from "../ui/badge";

/** Below this the backend's verdict is a proposal, and the badge says so. */
const PROPOSED_BELOW = 0.6;

const KIND_COLORS: Record<TaskKind, string> = {
	feature: "border-sky-500/40 text-sky-700 dark:text-sky-300",
	bug_fix: "border-rose-500/40 text-rose-700 dark:text-rose-300",
	hotfix: "border-red-600/60 text-red-700 dark:text-red-300 font-semibold",
	investigation: "border-violet-500/40 text-violet-700 dark:text-violet-300",
	run: "border-amber-500/40 text-amber-700 dark:text-amber-300",
	refactoring: "border-teal-500/40 text-teal-700 dark:text-teal-300",
	test: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
	docs: "border-slate-500/40 text-slate-700 dark:text-slate-300",
	spike: "border-fuchsia-500/40 text-fuchsia-700 dark:text-fuchsia-300",
};

interface TaskKindBadgeProps {
	task: Task;
	/** When true, the badge is a select that persists the user's choice. */
	editable?: boolean;
	className?: string;
}

/**
 * The kind of work a card asks for (`task.metadata.kind`), written by the
 * spec pipeline without a model and overridable here. A choice made here is
 * recorded with `kindSource: "user"`, which the backend never overwrites.
 */
export function TaskKindBadge({
	task,
	editable = false,
	className,
}: TaskKindBadgeProps) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const selectId = useId();
	const [saving, setSaving] = useState(false);

	const kind = task.metadata?.kind;
	if (!kind) return null;

	const source = task.metadata?.kindSource;
	const confidence = task.metadata?.kindConfidence;
	const proposed =
		source !== "user" &&
		typeof confidence === "number" &&
		confidence < PROPOSED_BELOW;
	const label = t(`kind.values.${kind}`);
	const sourceLabel = source ? t(`kind.source.${source}`) : "";
	const title = [t("kind.label"), label, sourceLabel, t("kind.help")]
		.filter(Boolean)
		.join(" · ");

	const onChange = async (next: TaskKind) => {
		if (next === kind) return;
		setSaving(true);
		const ok = await persistUpdateTask(task.id, {
			metadata: { kind: next, kindSource: "user", kindConfidence: 1 },
		});
		setSaving(false);
		if (!ok) {
			toast({ title: t("kind.change"), variant: "destructive" });
		}
	};

	if (!editable) {
		return (
			<Badge
				variant="outline"
				className={cn("text-xs", KIND_COLORS[kind], className)}
				title={title}
			>
				<Tag className="h-3 w-3 mr-1" aria-hidden="true" />
				{label}
				{proposed && (
					<span className="ml-1 opacity-70">({t("kind.proposed")})</span>
				)}
			</Badge>
		);
	}

	return (
		<label
			htmlFor={selectId}
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
				KIND_COLORS[kind],
				className,
			)}
			title={title}
		>
			<Tag className="h-3 w-3" aria-hidden="true" />
			<span className="sr-only">{t("kind.change")}</span>
			<select
				id={selectId}
				value={kind}
				disabled={saving}
				onChange={(e) => void onChange(e.target.value as TaskKind)}
				className="bg-transparent text-xs outline-none cursor-pointer"
				aria-label={t("kind.change")}
			>
				{TASK_KINDS.map((k) => (
					<option key={k} value={k}>
						{t(`kind.values.${k}`)}
					</option>
				))}
			</select>
			{source === "user" ? (
				<span className="opacity-70">({t("kind.chosen")})</span>
			) : proposed ? (
				<span className="opacity-70">({t("kind.proposed")})</span>
			) : null}
		</label>
	);
}
