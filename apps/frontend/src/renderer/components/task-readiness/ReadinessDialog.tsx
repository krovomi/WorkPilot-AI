import { AlertTriangle, Check, Loader2, Play, Sparkles, WandSparkles } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpecInterviewQuestion, Task } from "../../../shared/types";
import { toast } from "../../hooks/use-toast";
import { cardBody } from "../../../shared/utils/task-readiness";
import { countRunning } from "../../lib/group-move";
import { cn, sanitizeMarkdownForDisplay } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { type HeldCard, useTaskReadinessStore } from "../../stores/task-readiness-store";
import { persistTaskStatus, persistUpdateTask, useTaskStore } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/** How much of the card the dialog shows: enough to see what the agent reads. */
const CARD_EXCERPT_CHARS = 240;

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
	const waiting = useTaskReadinessStore((s) => s.held.length);
	const task = useTaskStore((s) => (held ? s.tasks.find((t) => t.id === held.taskId) : undefined));
	// A card deleted while it waited has nothing left to start: the next one shows.
	useEffect(() => {
		if (held && !task) useTaskReadinessStore.getState().release(held.taskId);
	}, [held, task]);
	if (!held || !task) return null;
	return <HeldCardDialog key={held.taskId} held={held} task={task} waiting={waiting} />;
}

function HeldCardDialog({ held, task, waiting }: { held: HeldCard; task: Task; waiting: number }) {
	const { t } = useTranslation(["tasks"]);
	const questions = held.readiness.questions ?? [];
	const problem = held.readiness.problem;
	// Empty until the person writes or takes a suggestion: a suggestion left
	// untouched is never written into the description.
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const release = () => useTaskReadinessStore.getState().release(task.id);
	const answer = (id: string, value: string) => setAnswers((a) => ({ ...a, [id]: value }));

	const answeredCount = questions.filter((q) => answers[q.id]?.trim()).length;
	const run = async (save: boolean) => {
		if (busy || (save && answeredCount === 0)) return;
		setBusy(true);
		try {
			if (save) {
				// The card as it is now, so what the person wrote on it stays first.
				const current = useTaskStore.getState().tasks.find((x) => x.id === task.id) ?? task;
				const description = `${current.description ?? ""}${clarificationsSection(t("tasks:readiness.sectionTitle"), questions, answers)}`;
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
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void run(true);
		}
	};

	const body = cardBody(task);
	const Icon = problem ? AlertTriangle : Sparkles;
	return (
		<Dialog open onOpenChange={(open) => !open && !busy && release()}>
			<DialogContent maximizable={false} className="sm:max-w-xl" data-readiness-dialog="" onKeyDown={onKeyDown}>
				<div className="flex items-start gap-3 pr-8">
					<span
						className={cn(
							"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
							problem ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
						)}
						aria-hidden="true"
					>
						<Icon className="h-4.5 w-4.5" />
					</span>
					<div className="min-w-0 space-y-1">
						<p
							className={cn(
								"font-mono text-2xs font-semibold uppercase tracking-wider",
								problem ? "text-destructive" : "text-primary",
							)}
						>
							{waiting > 1
								? t("tasks:readiness.kickerMany", { count: waiting })
								: t("tasks:readiness.kicker")}
						</p>
						<DialogTitle className="line-clamp-2 text-base font-semibold leading-snug">{task.title}</DialogTitle>
						<DialogDescription className="text-sm text-muted-foreground">
							{problem ? t("tasks:readiness.problemIntro") : t("tasks:readiness.questionsIntro")}
						</DialogDescription>
					</div>
				</div>

				{problem ? (
					<p
						role="alert"
						className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-foreground"
					>
						{t(`tasks:readiness.problems.${problem}`)}
					</p>
				) : (
					<div className="mt-4 min-h-0 space-y-4 overflow-y-auto pr-1">
						<section
							aria-label={t("tasks:readiness.cardReads")}
							className="rounded-xl border border-dashed border-border bg-muted/30 px-3.5 py-2.5"
						>
							<p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
								{t("tasks:readiness.cardReads")}
							</p>
							<p className={cn("mt-1 line-clamp-3 text-sm", !body && "italic text-muted-foreground")}>
								{body ? sanitizeMarkdownForDisplay(body, CARD_EXCERPT_CHARS) : t("tasks:readiness.titleOnly")}
							</p>
						</section>

						<ol className="space-y-3">
							{questions.map((q, index) => {
								const value = answers[q.id] ?? "";
								const done = value.trim().length > 0;
								const fieldId = `readiness-${task.id}-${q.id}`;
								return (
									<li key={q.id} className="flex gap-3" data-readiness-question={q.id}>
										<span
											className={cn(
												"mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
												done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
											)}
											aria-hidden="true"
										>
											{done ? <Check className="h-3.5 w-3.5" /> : index + 1}
										</span>
										<div className="min-w-0 flex-1 space-y-1.5">
											<label htmlFor={fieldId} className="block text-sm font-medium leading-snug">
												{q.question}
											</label>
											<textarea
												id={fieldId}
												rows={1}
												value={value}
												disabled={busy}
												onChange={(e) => answer(q.id, e.target.value)}
												placeholder={t("tasks:readiness.answerPlaceholder")}
												className="block max-h-32 min-h-9 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm [field-sizing:content] placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
											/>
											{q.suggestion && value.trim() !== q.suggestion && (
												<button
													type="button"
													disabled={busy}
													onClick={() => answer(q.id, q.suggestion ?? "")}
													className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
												>
													<WandSparkles className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
													<span className="truncate">
														{t("tasks:readiness.useSuggestion", { suggestion: q.suggestion })}
													</span>
												</button>
											)}
										</div>
									</li>
								);
							})}
						</ol>
					</div>
				)}

				<div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
					{problem ? (
						<Button className="ml-auto" onClick={release}>
							{t("tasks:readiness.close")}
						</Button>
					) : (
						<>
							<Button variant="ghost" size="sm" onClick={release} disabled={busy}>
								{t("tasks:readiness.later")}
							</Button>
							<span className="flex-1" />
							<Button variant="outline" size="sm" onClick={() => void run(false)} disabled={busy}>
								{t("tasks:readiness.startAnyway")}
							</Button>
							<Button size="sm" className="gap-1.5" onClick={() => void run(true)} disabled={busy || answeredCount === 0}>
								{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
								{t("tasks:readiness.saveAndStart")}
							</Button>
							<p className="w-full text-right text-2xs text-muted-foreground">
								{t("tasks:readiness.footerHint")}
							</p>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
