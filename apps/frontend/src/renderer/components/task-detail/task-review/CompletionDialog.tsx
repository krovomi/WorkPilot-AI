import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../../shared/types";
import { computeCompletionChecklist } from "../../../../shared/utils/task-lifecycle";
import { cn } from "../../../lib/utils";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../ui/alert-dialog";

interface CompletionDialogProps {
	readonly open: boolean;
	readonly task: Task;
	readonly isCompleting: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onConfirm: () => void;
}

function ChecklistRow({ ok, label }: { ok: boolean; label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm">
			{ok ? (
				<CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
			) : (
				<XCircle className="h-4 w-4 shrink-0 text-warning" />
			)}
			<span className={ok ? "text-foreground" : "text-muted-foreground"}>
				{label}
			</span>
		</div>
	);
}

/**
 * Definition-of-Done confirmation shown before closing a task from human review.
 *
 * Soft guard: it surfaces whether a PR and visual proof exist, but never blocks —
 * when something is missing it swaps the primary action to "Close anyway" so a
 * legitimate close (PR merged on the platform, non-UI change…) is never
 * frustrated.
 */
export function CompletionDialog({
	open,
	task,
	isCompleting,
	onOpenChange,
	onConfirm,
}: CompletionDialogProps) {
	const { t } = useTranslation(["taskReview", "common"]);
	const { hasPr, hasVisualProof, ready } = computeCompletionChecklist(task);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<CheckCircle2 className="h-5 w-5 text-success" />
						{t("taskReview:close.title")}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3 text-sm text-muted-foreground">
							<p>{t("taskReview:close.description")}</p>

							<div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
								<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									{t("taskReview:close.checklistTitle")}
								</p>
								<ChecklistRow
									ok={hasPr}
									label={
										hasPr
											? t("taskReview:close.prPresent")
											: t("taskReview:close.prMissing")
									}
								/>
								<ChecklistRow
									ok={hasVisualProof}
									label={
										hasVisualProof
											? t("taskReview:close.proofPresent")
											: t("taskReview:close.proofMissing")
									}
								/>
							</div>

							{!ready && (
								<div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5">
									<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
									<p className="text-warning">
										{t("taskReview:close.softWarning")}
									</p>
								</div>
							)}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isCompleting}>
						{t("common:buttons.cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={(e) => {
							e.preventDefault();
							onConfirm();
						}}
						disabled={isCompleting}
						className={cn(
							ready
								? "bg-success text-success-foreground hover:bg-success/90"
								: "bg-warning text-warning-foreground hover:bg-warning/90",
						)}
					>
						{isCompleting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("taskReview:close.closing")}
							</>
						) : (
							<>
								<CheckCircle2 className="mr-2 h-4 w-4" />
								{ready
									? t("taskReview:close.confirm")
									: t("taskReview:close.confirmAnyway")}
							</>
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
