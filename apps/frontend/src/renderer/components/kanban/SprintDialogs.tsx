/**
 * The dialogs of the Kanban's sprints: creating or editing one (name, goal,
 * days) and closing the active one (what it did, where its unfinished cards
 * go). Opened from the toolbar's « Sprints » menu (SprintMenu).
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Sprint } from "../../../shared/types";
import { cleanSprintDraft, MAX_SPRINT_GOAL, MAX_SPRINT_NAME, orderedSprints } from "../../../shared/utils/sprints";
import { toast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { type SprintOutcome, sprintReport, useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DateField } from "../ui/date-fields";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/** Tells the person a sprint change failed, and why when it is known. */
export function useSprintFailure() {
	const { t } = useTranslation(["tasks"]);
	return (outcome: SprintOutcome): boolean => {
		if (outcome.ok) return true;
		toast({
			variant: "destructive",
			title:
				outcome.error === "cards_not_moved"
					? t("tasks:kanban.sprints.cardsNotMoved", { count: outcome.failedCards })
					: t("tasks:kanban.sprints.saveFailed"),
		});
		return false;
	};
}

interface SprintEditDialogProps {
	/** The sprint edited; absent creates one. */
	sprint?: Sprint;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SprintEditDialog({ sprint, open, onOpenChange }: SprintEditDialogProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const ids = useId();
	const save = useSprintStore((s) => s.save);
	const failed = useSprintFailure();
	const [name, setName] = useState(sprint?.name ?? "");
	const [goal, setGoal] = useState(sprint?.goal ?? "");
	const [startDate, setStartDate] = useState(sprint?.startDate ?? "");
	const [endDate, setEndDate] = useState(sprint?.endDate ?? "");
	const [saving, setSaving] = useState(false);
	const draft = cleanSprintDraft({ id: sprint?.id, name, goal, startDate, endDate });
	const endsTooSoon = !!startDate && !!endDate && endDate < startDate;

	const submit = async () => {
		if (!draft || saving) return;
		setSaving(true);
		const outcome = await save(draft);
		setSaving(false);
		if (failed(outcome)) onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{sprint ? t("tasks:kanban.sprints.editTitle") : t("tasks:kanban.sprints.newTitle")}</DialogTitle>
					<DialogDescription>{t("tasks:kanban.sprints.dialogHint")}</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<div className="space-y-1.5">
						<Label htmlFor={`${ids}-name`}>{t("tasks:kanban.sprints.name")}</Label>
						<Input
							id={`${ids}-name`}
							value={name}
							maxLength={MAX_SPRINT_NAME}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("tasks:kanban.sprints.namePlaceholder")}
							autoFocus
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${ids}-goal`}>{t("tasks:kanban.sprints.goal")}</Label>
						<Textarea
							id={`${ids}-goal`}
							value={goal}
							maxLength={MAX_SPRINT_GOAL}
							rows={2}
							onChange={(event) => setGoal(event.target.value)}
							placeholder={t("tasks:kanban.sprints.goalPlaceholder")}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor={`${ids}-start`}>{t("tasks:kanban.sprints.startDate")}</Label>
							<DateField id={`${ids}-start`} value={startDate} onValueChange={setStartDate} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${ids}-end`}>{t("tasks:kanban.sprints.endDate")}</Label>
							<DateField id={`${ids}-end`} value={endDate} onValueChange={setEndDate} />
						</div>
					</div>
					{endsTooSoon && <p className="text-xs text-destructive">{t("tasks:kanban.sprints.endBeforeStart")}</p>}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							{t("common:buttons.cancel")}
						</Button>
						<Button type="submit" disabled={!draft || saving}>
							{sprint ? t("tasks:kanban.sprints.save") : t("tasks:kanban.sprints.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

interface SprintCompleteDialogProps {
	sprint: Sprint;
	onOpenChange: (open: boolean) => void;
}

/** Closes the active sprint: what was done, and where the unfinished cards go. */
export function SprintCompleteDialog({ sprint, onOpenChange }: SprintCompleteDialogProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const tasks = useTaskStore((s) => s.tasks);
	const sprints = useSprintStore((s) => s.sprints);
	const complete = useSprintStore((s) => s.complete);
	const failed = useSprintFailure();
	const planned = useMemo(() => orderedSprints(sprints).filter((item) => item.state === "planned"), [sprints]);
	const [carryTo, setCarryTo] = useState<string | null>(planned[0]?.id ?? null);
	const [closing, setClosing] = useState(false);
	const report = sprintReport(tasks, sprint.id, carryTo);

	// The button is disabled while closing: one close at a time.
	const submit = async () => {
		setClosing(true);
		const outcome = await complete(sprint.id, carryTo);
		setClosing(false);
		if (failed(outcome)) onOpenChange(false);
	};

	const choices: { id: string | null; label: string }[] = [
		...planned.map((item) => ({ id: item.id, label: item.name })),
		{ id: null, label: t("tasks:kanban.sprints.backlog") },
	];

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("tasks:kanban.sprints.completeTitle", { name: sprint.name })}</DialogTitle>
					<DialogDescription>
						{t("tasks:kanban.sprints.completeSummary", {
							done: report.done,
							donePoints: report.donePoints,
							carried: report.carried,
						})}
					</DialogDescription>
				</DialogHeader>
				{report.carried > 0 && (
					<fieldset className="space-y-1.5">
						<legend className="mb-1 text-sm font-medium">{t("tasks:kanban.sprints.carryTo")}</legend>
						{choices.map((choice) => (
							<button
								key={choice.id ?? "backlog"}
								type="button"
								aria-pressed={carryTo === choice.id}
								onClick={() => setCarryTo(choice.id)}
								className={cn(
									"flex w-full items-center rounded-lg border px-3 py-2 text-left text-sm transition-colors",
									carryTo === choice.id
										? "border-primary bg-primary/10 text-foreground"
										: "border-border/60 text-muted-foreground hover:text-foreground",
								)}
							>
								<span className="truncate">{choice.label}</span>
							</button>
						))}
					</fieldset>
				)}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						{t("common:buttons.cancel")}
					</Button>
					<Button type="button" onClick={() => void submit()} disabled={closing}>
						{t("tasks:kanban.sprints.complete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
