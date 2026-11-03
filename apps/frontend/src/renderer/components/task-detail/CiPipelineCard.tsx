import { ExternalLink, Loader2, Workflow, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PipelineRunState, Task } from "../../../shared/types";
import { useTaskStore } from "../../stores/task-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type Variant = "success" | "destructive" | "warning" | "muted" | "outline";

const VARIANT: Record<Exclude<PipelineRunState, "none">, Variant> = {
	queued: "outline",
	running: "outline",
	succeeded: "success",
	partiallySucceeded: "warning",
	failed: "destructive",
	canceled: "muted",
};

/**
 * The CI run on the task's branch, in the panel.
 *
 * The main process polls the project's CI provider for the latest run on
 * `workpilot/{specId}` and pushes it to `task-store.pipelineStatuses`; the
 * Kanban card showed it as a badge with a repair button, the panel did not show
 * it at all — a red build was only visible from the board. Same data, same
 * repair action (`fixRedBuild`), here where the task is read.
 *
 * Renders nothing when no run is known for the branch (no CI configured, or
 * nothing pushed yet).
 */
export function CiPipelineCard({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const pipeline = useTaskStore((s) => s.pipelineStatuses[task.id]);
	const [isFixing, setIsFixing] = useState(false);

	if (!pipeline || pipeline.state === "none") return null;

	const repairing = isFixing || pipeline.autoFixInProgress;
	const repair = async () => {
		setIsFixing(true);
		try {
			await globalThis.electronAPI.fixRedBuild(task.id);
		} finally {
			setIsFixing(false);
		}
	};
	const run = pipeline.buildNumber ?? pipeline.definitionName;

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<Workflow className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:ciPipeline.title")}</span>
						<Badge variant={VARIANT[pipeline.state]} className="text-3xs">
							{t(`tasks:ciPipeline.state.${pipeline.state}`)}
						</Badge>
					</div>
					<p className="text-xs text-muted-foreground">
						{t("tasks:ciPipeline.run", {
							provider: pipeline.providerLabel ?? t("tasks:labels.pipeline"),
							run: run ?? "",
							branch: pipeline.branch ?? "",
						})}
					</p>
					{pipeline.state === "failed" && repairing && (
						<p className="text-xs">{t("tasks:ciPipeline.repairing")}</p>
					)}
				</div>
				<div className="flex shrink-0 flex-wrap justify-end gap-2">
					{pipeline.webUrl && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => void globalThis.electronAPI?.openExternal?.(pipeline.webUrl ?? "")}
						>
							<ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
							{t("tasks:ciPipeline.open")}
						</Button>
					)}
					{pipeline.state === "failed" && (
						<Button size="sm" variant="outline" disabled={repairing} onClick={() => void repair()}>
							{repairing ? (
								<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
							) : (
								<Wrench className="mr-1 h-3.5 w-3.5" aria-hidden />
							)}
							{t("tasks:labels.repairBuild")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
