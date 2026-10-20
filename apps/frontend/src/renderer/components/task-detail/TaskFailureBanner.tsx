import { AlertOctagon, AlertTriangle, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { Button } from "../ui/button";

interface TaskFailureBannerProps {
	readonly task: Task;
}

/**
 * What actually went wrong, said out loud.
 *
 * A failed build moves the card to Human Review with a red "Has Errors" badge.
 * That badge is a label, not an explanation: the sentence that would let the
 * user act — the planner produced an unparseable plan, the local model never
 * called a tool, QA gave up after N passes — used to live only in the backend
 * log. The banner is where it lands now, at the top of the task panel, with a
 * copy button because the first thing anyone does with an error is paste it
 * somewhere.
 *
 * Renders nothing when the task did not fail: a permanently-present "no errors"
 * strip is a strip nobody reads.
 *
 * A finished build whose QA agent could not reach a verdict
 * (`reviewReason === "qa_unverified"`) gets the same sentence, as a warning:
 * the work is done and reviewable, so the red "this task failed" read as a
 * blocking failure on a task the board also showed at 100%.
 */
export function TaskFailureBanner({ task }: TaskFailureBannerProps) {
	const { t } = useTranslation(["tasks"]);
	const [copied, setCopied] = useState(false);

	const failed =
		task.status === "error" ||
		(task.status === "human_review" && task.reviewReason === "errors");
	const unverified =
		task.status === "human_review" && task.reviewReason === "qa_unverified";
	if (!failed && !unverified) return null;

	const ns = unverified ? "qaUnverified" : "failure";
	const Icon = unverified ? AlertTriangle : AlertOctagon;

	const message = task.errorMessage?.trim();

	const handleCopy = () => {
		void navigator.clipboard
			?.writeText(message ?? "")
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {
				/* Un presse-papiers indisponible ne casse pas la bannière. */
			});
	};

	return (
		<div
			role={unverified ? "status" : "alert"}
			className={
				unverified
					? "mx-4 mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3"
					: "mx-4 mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
			}
		>
			<div className="flex items-start gap-2">
				<Icon
					className={`mt-0.5 h-4 w-4 shrink-0 ${unverified ? "text-warning" : "text-destructive"}`}
				/>
				<div className="min-w-0 flex-1">
					<p
						className={`text-sm font-medium ${unverified ? "text-warning" : "text-destructive"}`}
					>
						{t(`tasks:${ns}.title`)}
					</p>
					{message ? (
						<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/90">
							{message}
						</pre>
					) : (
						// The backend halted without naming a cause. Saying so is
						// still better than an empty panel: it tells the user the
						// detail is in the logs rather than leaving them to wonder
						// whether the UI simply failed to render it.
						<p className="mt-1 text-xs text-muted-foreground">
							{t(`tasks:${ns}.unknown`)}
						</p>
					)}
					<p className="mt-2 text-xs text-muted-foreground">
						{t(`tasks:${ns}.hint`)}
					</p>
				</div>
				{message && (
					<Button
						variant="ghost"
						size="sm"
						onClick={handleCopy}
						className="shrink-0 gap-1.5 text-muted-foreground hover:text-destructive"
						aria-label={t("tasks:failure.copy")}
					>
						<Copy className="h-3.5 w-3.5" />
						{copied ? t("tasks:failure.copied") : t("tasks:failure.copy")}
					</Button>
				)}
			</div>
		</div>
	);
}
