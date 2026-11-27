/**
 * Flag tasks « Bloquée » (Jira's flag): the person says what blocks them.
 * Mounted once by the board (BoardDialogs); opened by
 * stores/flag-request-store.ts.
 */
import { Flag, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_FLAG_REASON } from "../../../shared/utils/task-flag";
import { toast } from "../../hooks/use-toast";
import { useFlagRequestStore } from "../../stores/flag-request-store";
import { flagTask } from "../../stores/task-flag-actions";
import { useTaskStore } from "../../stores/task-store";
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

export function FlagRequestDialog() {
	const { t } = useTranslation(["tasks", "common"]);
	const ids = useFlagRequestStore((s) => s.ids);
	const close = useFlagRequestStore((s) => s.close);
	const allTasks = useTaskStore((s) => s.tasks);
	const tasks = useMemo(() => {
		const wanted = new Set(ids);
		return allTasks.filter((task) => wanted.has(task.id));
	}, [allTasks, ids]);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const open = tasks.length > 0;

	useEffect(() => {
		if (open) setReason("");
	}, [open]);

	const onFlag = async () => {
		setBusy(true);
		try {
			const results = await Promise.all(tasks.map((task) => flagTask(task.id, reason)));
			const failed = results.find((r) => !r.success);
			if (failed) {
				toast({
					title: t("tasks:flag.failedTitle"),
					description: failed.error || t("tasks:flag.failedDescription"),
					variant: "destructive",
				});
			}
			close();
		} finally {
			setBusy(false);
		}
	};

	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) close();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<Flag className="h-5 w-5 text-destructive" />
						{t("tasks:flag.dialogTitle", { count: tasks.length })}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3 text-sm text-muted-foreground">
							<p>{t("tasks:flag.dialogDescription", { count: tasks.length })}</p>
							<Textarea
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								placeholder={t("tasks:flag.reasonPlaceholder")}
								aria-label={t("tasks:flag.reasonLabel")}
								maxLength={MAX_FLAG_REASON}
								className="min-h-20 resize-none"
								disabled={busy}
							/>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy}>{t("common:buttons.cancel")}</AlertDialogCancel>
					<AlertDialogAction
						onClick={(e) => {
							e.preventDefault();
							void onFlag();
						}}
						disabled={busy}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{busy ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Flag className="mr-2 h-4 w-4" />
						)}
						{t("tasks:flag.flag")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
