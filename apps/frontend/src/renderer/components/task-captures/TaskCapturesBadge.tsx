import { Camera } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { cn } from "../../lib/utils";
import {
	CAPTURES_STATE_VARIANT,
	capturesState,
	firstPreviewFile,
	hasScreens,
	replacedKinds,
} from "./captures-state";
import { useCaptureImage } from "./useCaptureImage";

const TONE: Record<string, string> = {
	success: "bg-success/10 text-success",
	warning: "bg-warning/10 text-warning",
	info: "bg-info/10 text-info",
	muted: "bg-muted text-muted-foreground",
	destructive: "bg-destructive/10 text-destructive",
};

/**
 * The camera on a Kanban card whose task has captures for its PR: how many
 * screens, and where they stand (in the PR, waiting for a « Publish »,
 * kept on the task, held back). Nothing when the task has none.
 */
export function TaskCapturesBadge({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const summary = task.captures;
	if (!hasScreens(summary)) return null;
	const state = capturesState(summary);
	const label = t(`tasks:captures.state.${state}`);
	return (
		<span
			className={cn(
				"mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-medium",
				TONE[CAPTURES_STATE_VARIANT[state]],
			)}
			title={t("tasks:captures.badge.title", { count: summary.items.length, state: label })}
			data-testid="task-captures-badge"
			data-state={state}
		>
			<Camera className="h-3 w-3" aria-hidden="true" />
			<span>{t("tasks:captures.badge.count", { count: summary.items.length })}</span>
		</span>
	);
}

/**
 * The same, in the card's hover preview: the first screen as the PR shows it
 * (personal data already replaced by fakes), and what was replaced.
 */
export function TaskCapturesPreview({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const summary = task.captures;
	const file = hasScreens(summary) ? firstPreviewFile(summary) : undefined;
	const image = useCaptureImage(task.id, file, summary?.generatedAt);
	if (!hasScreens(summary)) return null;
	const state = capturesState(summary);
	const kinds = replacedKinds(summary);
	return (
		<div className="space-y-1.5 border-t border-border pt-2" data-testid="task-captures-preview">
			<p className="inline-flex items-center gap-1 font-medium text-foreground">
				<Camera className="h-3 w-3" aria-hidden="true" />
				{t("tasks:captures.badge.title", {
					count: summary.items.length,
					state: t(`tasks:captures.state.${state}`),
				})}
			</p>
			{image.source && (
				<img
					src={image.source}
					alt={t("tasks:captures.previewAlt", {
						label: summary.items[0]?.label || summary.items[0]?.route || "",
					})}
					className="max-h-40 w-full rounded border border-border object-cover object-top"
				/>
			)}
			{kinds.length > 0 && (
				<p className="text-muted-foreground">
					{t("tasks:captures.fakesReplaced", {
						kinds: kinds.map((kind) => t(`tasks:captures.kinds.${kind}`, { defaultValue: kind })).join(", "),
					})}
				</p>
			)}
		</div>
	);
}
