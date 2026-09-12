import { AlertOctagon, Copy } from "lucide-react";
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
 */
export function TaskFailureBanner({ task }: TaskFailureBannerProps) {
	const { t } = useTranslation(["tasks"]);
	const [copied, setCopied] = useState(false);

	const failed =
		task.status === "error" ||
		(task.status === "human_review" && task.reviewReason === "errors");
	if (!failed) return null;

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
			role="alert"
			className="mx-4 mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3"
		>
			<div className="flex items-start gap-2">
				<AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium text-destructive">
						{t("tasks:failure.title")}
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
							{t("tasks:failure.unknown")}
						</p>
					)}
					<p className="mt-2 text-xs text-muted-foreground">
						{t("tasks:failure.hint")}
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
