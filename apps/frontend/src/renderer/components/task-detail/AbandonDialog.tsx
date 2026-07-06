import { Ban, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui/alert-dialog";
import { Textarea } from "../ui/textarea";

interface AbandonDialogProps {
	readonly open: boolean;
	readonly task: Task;
	readonly isAbandoning: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAbandon: (reason?: string) => void;
}

/**
 * Confirmation for abandoning a task (e.g. the product owner deprioritized it).
 * Reversible — the task is greyed + badged in the Kanban and can be resumed; an
 * optional reason is stored for context. Nothing is deleted.
 */
export function AbandonDialog({
	open,
	task,
	isAbandoning,
	onOpenChange,
	onAbandon,
}: AbandonDialogProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const [reason, setReason] = useState("");

	// Reset the field whenever the dialog re-opens.
	useEffect(() => {
		if (open) setReason("");
	}, [open]);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<Ban className="h-5 w-5 text-warning" />
						{t("tasks:abandon.dialogTitle")}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3 text-sm text-muted-foreground">
							<p>
								{t("tasks:abandon.dialogPrefix")}{" "}
								<strong className="text-foreground">
									&quot;{task.title}&quot;
								</strong>
								{t("tasks:abandon.dialogSuffix")}
							</p>
							<p>{t("tasks:abandon.dialogReversible")}</p>
							<Textarea
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								placeholder={t("tasks:abandon.reasonPlaceholder")}
								className="min-h-20 resize-none"
								disabled={isAbandoning}
							/>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isAbandoning}>
						{t("common:buttons.cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={(e) => {
							e.preventDefault();
							onAbandon(reason);
						}}
						disabled={isAbandoning}
						className="bg-warning text-warning-foreground hover:bg-warning/90"
					>
						{isAbandoning ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("tasks:abandon.abandoning")}
							</>
						) : (
							<>
								<Ban className="mr-2 h-4 w-4" />
								{t("tasks:abandon.abandon")}
							</>
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
