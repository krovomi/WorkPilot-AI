import { CheckCircle2, ExternalLink, Workflow, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CicdAutoRun } from "../../../shared/types";
import { useFormatRelativeTime } from "@/hooks/useFormatRelativeTime";

const PROVIDER_NAMES: Record<string, string> = {
	github: "GitHub Actions",
	gitlab: "GitLab CI",
	azure: "Azure DevOps",
	jenkins: "Jenkins",
};

/**
 * The pipeline CI/CD Triggers started when the task's pull request was
 * opened or merged (`metadata.cicdRun`), under the PR link of the task's details.
 */
export function TaskCicdRun({ run }: { readonly run: CicdAutoRun }) {
	const { t } = useTranslation(["tasks"]);
	const formatRelativeTime = useFormatRelativeTime();
	const provider = PROVIDER_NAMES[run.provider] ?? run.provider;
	const when = formatRelativeTime(new Date(run.triggeredAt));
	const failed = run.status === "failed";
	return (
		<div className="mt-2 space-y-1 text-sm" data-testid="task-cicd-run">
			<div className="flex items-center gap-1.5 text-foreground/80">
				<Workflow className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
				{failed ? (
					<XCircle className="h-3 w-3 text-destructive" aria-hidden="true" />
				) : (
					<CheckCircle2 className="h-3 w-3 text-success" aria-hidden="true" />
				)}
				<span>
					{t(`tasks:metadata.cicdRun.${failed ? "failed" : "triggered"}_${run.event === "merge" ? "merge" : "pr"}`, {
						provider,
						when,
					})}
				</span>
				{run.webUrl && (
					<button
						type="button"
						onClick={() => run.webUrl && globalThis.electronAPI.openExternal(run.webUrl)}
						className="flex items-center gap-1 border-none bg-transparent p-0 text-info hover:underline"
					>
						{t("tasks:metadata.cicdRun.open")}
						<ExternalLink className="h-3 w-3" aria-hidden="true" />
					</button>
				)}
			</div>
			{failed && run.error && (
				<p className="break-words text-xs text-muted-foreground">{run.error}</p>
			)}
		</div>
	);
}
