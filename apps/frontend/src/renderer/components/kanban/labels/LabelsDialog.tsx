/**
 * Edit a card's labels (Jira's labels): add one by typing it or picking one
 * the board already uses, remove one with its ×. Mounted once by the board
 * (BoardDialogs); opened by stores/label-request-store.ts.
 * Design: docs/architecture/kanban-labels.md.
 */
import { Loader2, Tag, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { boardLabels, cleanLabel, cleanLabels, MAX_LABEL_LENGTH, MAX_LABELS, taskLabels } from "../../../../shared/utils/task-labels";
import { toast } from "../../../hooks/use-toast";
import { useLabelRequestStore } from "../../../stores/label-request-store";
import { saveCardMetadata } from "../../../stores/task-flag-actions";
import { useTaskStore } from "../../../stores/task-store";
import type { Task } from "../../../../shared/types";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";

const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

export function LabelsDialog() {
	const taskId = useLabelRequestStore((s) => s.taskId);
	const tasks = useTaskStore((s) => s.tasks);
	const task = tasks.find((item) => item.id === taskId);
	// Keyed by the card: the edit starts from its labels, and a refresh of the card keeps it.
	return task ? <LabelsEditor key={task.id} task={task} tasks={tasks} /> : null;
}

function LabelsEditor({ task, tasks }: { readonly task: Task; readonly tasks: readonly Task[] }) {
	const { t } = useTranslation(["tasks", "common"]);
	const close = useLabelRequestStore((s) => s.close);
	const [labels, setLabels] = useState<string[]>(() => taskLabels(task));
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);

	const full = labels.length >= MAX_LABELS;
	const suggestions = boardLabels(tasks).filter((label) => !labels.some((item) => same(item, label)));
	const add = (raw: string) => {
		// The input is disabled once the card is full.
		const label = cleanLabel(raw);
		if (!label) return;
		setLabels((current) => cleanLabels([...current, label]));
		setDraft("");
	};
	const remove = (label: string) => setLabels((current) => current.filter((item) => item !== label));

	const onSave = async () => {
		setBusy(true);
		try {
			const result = await saveCardMetadata(task.id, { labels });
			if (!result.success) {
				toast({
					title: t("tasks:cardLabels.failedTitle"),
					description: result.error || t("tasks:cardLabels.failedDescription"),
					variant: "destructive",
				});
				return;
			}
			close();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next && !busy) close();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Tag className="h-5 w-5 text-primary" />
						{t("tasks:cardLabels.dialogTitle")}
					</DialogTitle>
					<DialogDescription>{t("tasks:cardLabels.dialogDescription", { title: task.title })}</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<ul className="flex min-h-7 flex-wrap gap-1.5" aria-label={t("tasks:cardLabels.listLabel")}>
						{labels.length === 0 && <li className="text-xs text-muted-foreground">{t("tasks:cardLabels.none")}</li>}
						{labels.map((label) => (
							<li
								key={label}
								className="flex items-center gap-1 rounded border border-border/60 bg-muted/50 py-0.5 pr-1 pl-2 text-xs"
							>
								{label}
								<button
									type="button"
									onClick={() => remove(label)}
									aria-label={t("tasks:cardLabels.remove", { label })}
									className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
									disabled={busy}
								>
									<X className="h-3 w-3" />
								</button>
							</li>
						))}
					</ul>
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							add(draft);
						}}
					>
						<Input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder={t("tasks:cardLabels.placeholder")}
							aria-label={t("tasks:cardLabels.inputLabel")}
							maxLength={MAX_LABEL_LENGTH}
							disabled={busy || full}
						/>
						<Button type="submit" variant="outline" disabled={busy || full || cleanLabel(draft) === null}>
							{t("tasks:cardLabels.add")}
						</Button>
					</form>
					{full && <p className="text-xs text-muted-foreground">{t("tasks:cardLabels.full", { count: MAX_LABELS })}</p>}
					{suggestions.length > 0 && !full && (
						<div className="space-y-1.5">
							<p className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
								{t("tasks:cardLabels.suggestions")}
							</p>
							<div className="flex flex-wrap gap-1.5">
								{suggestions.map((label) => (
									<button
										key={label}
										type="button"
										onClick={() => add(label)}
										className="rounded border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
										disabled={busy}
									>
										{t("tasks:cardLabels.suggest", { label })}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={close} disabled={busy}>
						{t("common:buttons.cancel")}
					</Button>
					<Button onClick={() => void onSave()} disabled={busy}>
						{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						{t("common:buttons.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
