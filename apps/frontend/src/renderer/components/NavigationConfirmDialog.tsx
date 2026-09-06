import type { Task } from "@shared/types/task";
import { Layers, PauseCircle, PlayCircle, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui";
import { cn } from "@/lib/utils";

interface NavigationConfirmDialogProps {
	open: boolean;
	runningTask: Task | null;
	/** How many tasks are running, so the dialog can speak in the plural. */
	runningCount?: number;
	/** Leave the tasks running and navigate anyway. */
	onBackground: () => void;
	onContinue: () => void;
	onStop: () => void;
	onPause: () => void;
	/** Bound to the "don't ask again" checkbox; undefined hides it. */
	dontAskAgain?: boolean;
	onDontAskAgainChange?: (value: boolean) => void;
}

interface ChoiceProps {
	icon: React.ReactNode;
	label: string;
	description: string;
	onClick: () => void;
	emphasis?: boolean;
	destructive?: boolean;
}

function Choice({
	icon,
	label,
	description,
	onClick,
	emphasis,
	destructive,
}: ChoiceProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
				"hover:bg-accent",
				emphasis ? "border-primary/60 bg-primary/5" : "border-border",
			)}
		>
			{icon}
			<div>
				<p
					className={cn(
						"text-sm font-medium",
						destructive ? "text-destructive" : "text-foreground",
					)}
				>
					{label}
				</p>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
		</button>
	);
}

export function NavigationConfirmDialog({
	open,
	runningTask,
	runningCount = runningTask ? 1 : 0,
	onBackground,
	onContinue,
	onStop,
	onPause,
	dontAskAgain,
	onDontAskAgainChange,
}: NavigationConfirmDialogProps) {
	const { t } = useTranslation("common");

	// Beyond the first task the title alone stops being useful: name the one the
	// user is most likely thinking of and count the rest.
	const extraCount = Math.max(0, runningCount - 1);

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onContinue();
			}}
		>
			<DialogContent hideCloseButton className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("navigationConfirm.title")}</DialogTitle>
					<DialogDescription>
						{t("navigationConfirm.description")}
					</DialogDescription>
				</DialogHeader>

				{runningTask && (
					<p className="text-sm font-medium text-foreground mt-2 px-1">
						{t("navigationConfirm.taskLabel", { taskTitle: runningTask.title })}
						{extraCount > 0 && (
							<span className="text-muted-foreground font-normal">
								{" "}
								{t("navigationConfirm.otherTasks", { count: extraCount })}
							</span>
						)}
					</p>
				)}

				<div className="flex flex-col gap-2 mt-4">
					<Choice
						emphasis
						icon={<Layers className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
						label={t("navigationConfirm.backgroundTask")}
						description={t("navigationConfirm.backgroundTaskDescription")}
						onClick={onBackground}
					/>

					<Choice
						icon={
							<PlayCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
						}
						label={t("navigationConfirm.continueTask")}
						description={t("navigationConfirm.continueTaskDescription")}
						onClick={onContinue}
					/>

					<Choice
						icon={
							<PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
						}
						label={t("navigationConfirm.pauseTask")}
						description={t("navigationConfirm.pauseTaskDescription")}
						onClick={onPause}
					/>

					<Choice
						destructive
						icon={<Square className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />}
						label={t("navigationConfirm.stopTask")}
						description={t("navigationConfirm.stopTaskDescription")}
						onClick={onStop}
					/>
				</div>

				{onDontAskAgainChange && (
					<label className="mt-4 flex items-center gap-2 px-1 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={dontAskAgain ?? false}
							onChange={(e) => onDontAskAgainChange(e.target.checked)}
							className="h-3.5 w-3.5 rounded border-border accent-primary"
						/>
						{t("navigationConfirm.dontAskAgain")}
					</label>
				)}
			</DialogContent>
		</Dialog>
	);
}
