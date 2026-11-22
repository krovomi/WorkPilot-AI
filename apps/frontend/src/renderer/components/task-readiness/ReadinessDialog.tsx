import { Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpecInterviewQuestion, Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { countRunning } from "../../lib/group-move";
import { useProjectStore } from "../../stores/project-store";
import { type HeldCard, useTaskReadinessStore } from "../../stores/task-readiness-store";
import { persistTaskStatus, persistUpdateTask, useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

/** The answers as a section of the description, for the planner. */
export function clarificationsSection(
	title: string,
	questions: readonly SpecInterviewQuestion[],
	answers: Readonly<Record<string, string>>,
): string {
	const lines = ["", "", `## ${title}`, ""];
	for (const q of questions) {
		const answer = answers[q.id]?.trim();
		if (answer) lines.push(`**${q.question}**`, "", answer, "");
	}
	return lines.join("\n");
}

/**
 * Starts a card the person let through: « En cours » while it has a free
 * slot, else the queue, like a card dropped there. The pre-analysis lets it
 * pass from now on.
 */
async function startAsIs(task: Task): Promise<void> {
	useTaskReadinessStore.getState().accept(task.id);
	const slots =
		useProjectStore.getState().projects.find((p) => p.id === task.projectId)?.settings?.maxParallelTasks ?? 3;
	const to = countRunning(useTaskStore.getState().tasks) < slots ? "in_progress" : "queue";
	if (task.status !== to) await persistTaskStatus(task.id, to, { skipReadiness: true });
}

/**
 * What the pre-analysis found on a card about to start
 * (docs/architecture/task-readiness.md): a machine check that would make the
 * start fail, or the questions of the review of a short card. Shown for the
 * first card held; the next one follows.
 */
export function ReadinessDialog() {
	const held = useTaskReadinessStore((s) => s.held[0]);
	const task = useTaskStore((s) => (held ? s.tasks.find((t) => t.id === held.taskId) : undefined));
	// A card deleted while it waited has nothing left to start: the next one shows.
	useEffect(() => {
		if (held && !task) useTaskReadinessStore.getState().release(held.taskId);
	}, [held, task]);
	if (!held || !task) return null;
	return <HeldCardDialog key={held.taskId} held={held} task={task} />;
}

function HeldCardDialog({ held, task }: { held: HeldCard; task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const questions = held.readiness.questions ?? [];
	const [answers, setAnswers] = useState<Record<string, string>>(() =>
		Object.fromEntries(questions.map((q) => [q.id, q.suggestion ?? ""])),
	);
	const [busy, setBusy] = useState(false);
	const release = () => useTaskReadinessStore.getState().release(task.id);

	const run = async (save: boolean) => {
		setBusy(true);
		try {
			if (save) {
				const description = `${task.description ?? ""}${clarificationsSection(t("tasks:readiness.sectionTitle"), questions, answers)}`;
				if (!(await persistUpdateTask(task.id, { description }))) {
					toast({ title: t("tasks:readiness.saveFailed"), variant: "destructive" });
					return;
				}
			}
			await startAsIs(useTaskStore.getState().tasks.find((x) => x.id === task.id) ?? task);
		} finally {
			setBusy(false);
		}
	};

	const answered = questions.some((q) => answers[q.id]?.trim());
	return (
		<Dialog open onOpenChange={(open) => !open && !busy && release()}>
			<DialogContent className="sm:max-w-lg" data-readiness-dialog="">
				<DialogHeader>
					<DialogTitle>{t("tasks:readiness.title", { title: task.title })}</DialogTitle>
					<DialogDescription>
						{held.readiness.problem ? t("tasks:readiness.problemIntro") : t("tasks:readiness.questionsIntro")}
					</DialogDescription>
				</DialogHeader>
				{held.readiness.problem ? (
					<p className="text-sm">{t(`tasks:readiness.problems.${held.readiness.problem}`)}</p>
				) : (
					<div className="space-y-3">
						{questions.map((q) => (
							<label key={q.id} className="block space-y-1">
								<span className="text-sm font-medium">{q.question}</span>
								<Textarea
									rows={2}
									aria-label={t("tasks:readiness.answerLabel")}
									value={answers[q.id] ?? ""}
									onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
								/>
							</label>
						))}
					</div>
				)}
				<DialogFooter>
					{held.readiness.problem ? (
						<Button onClick={release}>{t("tasks:readiness.close")}</Button>
					) : (
						<>
							<Button variant="ghost" onClick={release} disabled={busy}>
								{t("tasks:readiness.later")}
							</Button>
							<Button variant="outline" onClick={() => void run(false)} disabled={busy}>
								{t("tasks:readiness.startAnyway")}
							</Button>
							<Button onClick={() => void run(true)} disabled={busy || !answered}>
								{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
								{t("tasks:readiness.saveAndStart")}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
