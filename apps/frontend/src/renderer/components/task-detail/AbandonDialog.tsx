import { Ban, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ABANDON_RESOLUTIONS,
	type AbandonResolution,
	type Task,
} from "../../../shared/types";
import type { AbandonChoice } from "../../../shared/utils/task-lifecycle";
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
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";

/** The resolutions a person picks; « PR fermée sans fusion » is written by the app. */
const PICKABLE = ABANDON_RESOLUTIONS.filter((r) => r !== "pr_closed");
const LINKED: ReadonlySet<AbandonResolution> = new Set(["duplicate", "replaced"]);
/** At most this many tasks are offered as the duplicate or the replacement. */
const MAX_LINK_CHOICES = 200;
/** The server keeps a note of this many characters at most (`shared_board/settings.py`). */
const MAX_REASON = 2000;

interface AbandonDialogProps {
	readonly open: boolean;
	/** The tasks set aside together: one from its panel, several from the board. */
	readonly tasks: readonly Pick<Task, "id" | "title">[];
	readonly isAbandoning: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onAbandon: (choice: AbandonChoice) => void;
}

/**
 * Confirmation for abandoning tasks (e.g. the product owner deprioritized
 * them). Reversible: they go to the « Abandonnée » column and can be resumed.
 * The person says why, as a resolution (won't do, duplicate, obsolete,
 * replaced, other), with the task it duplicates or that replaces it, and an
 * optional note. Nothing is deleted.
 */
export function AbandonDialog({
	open,
	tasks,
	isAbandoning,
	onOpenChange,
	onAbandon,
}: AbandonDialogProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const [reason, setReason] = useState("");
	const [resolution, setResolution] = useState<AbandonResolution>("wont_do");
	const [link, setLink] = useState("");
	const boardTasks = useTaskStore((s) => s.tasks);
	const linkChoices = useMemo(() => {
		const leaving = new Set(tasks.map((task) => task.id));
		return boardTasks
			.filter((task) => !leaving.has(task.id) && !task.metadata?.archivedAt)
			.slice(0, MAX_LINK_CHOICES);
	}, [boardTasks, tasks]);

	// Reset the fields whenever the dialog re-opens.
	useEffect(() => {
		if (open) {
			setReason("");
			setResolution("wont_do");
			setLink("");
		}
	}, [open]);

	const single = tasks.length === 1 ? tasks[0] : null;
	const linked = LINKED.has(resolution);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<Ban className="h-5 w-5 text-warning" />
						{single
							? t("tasks:abandon.dialogTitle")
							: t("tasks:abandon.dialogTitleMany", { count: tasks.length })}
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-3 text-sm text-muted-foreground">
							{single ? (
								<p>
									{t("tasks:abandon.dialogPrefix")}{" "}
									<strong className="text-foreground">
										&quot;{single.title}&quot;
									</strong>
									{t("tasks:abandon.dialogSuffix")}
								</p>
							) : (
								<p>{t("tasks:abandon.dialogMany", { count: tasks.length })}</p>
							)}
							<p>{t("tasks:abandon.dialogReversible")}</p>
							<div className="grid gap-1.5">
								<Label htmlFor="abandon-resolution" className="text-foreground">
									{t("tasks:abandon.resolutionLabel")}
								</Label>
								<NativeSelect
									id="abandon-resolution"
									value={resolution}
									onChange={(e) => setResolution(e.target.value as AbandonResolution)}
									disabled={isAbandoning}
								>
									{PICKABLE.map((r) => (
										<option key={r} value={r}>
											{t(`tasks:abandon.resolutions.${r}`)}
										</option>
									))}
								</NativeSelect>
							</div>
							{linked && (
								<div className="grid gap-1.5">
									<Label htmlFor="abandon-link" className="text-foreground">
										{t(`tasks:abandon.linkLabel.${resolution}`)}
									</Label>
									<NativeSelect
										id="abandon-link"
										value={link}
										onChange={(e) => setLink(e.target.value)}
										disabled={isAbandoning}
									>
										<option value="">{t("tasks:abandon.linkNone")}</option>
										{linkChoices.map((task) => (
											<option key={task.id} value={task.id}>
												{task.title}
											</option>
										))}
									</NativeSelect>
								</div>
							)}
							<Textarea
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								placeholder={t("tasks:abandon.reasonPlaceholder")}
								aria-label={t("tasks:abandon.reasonLabel")}
								className="min-h-20 resize-none"
								maxLength={MAX_REASON}
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
							onAbandon({ reason, resolution, ...(linked && link ? { link } : {}) });
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
