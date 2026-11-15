import { GraduationCap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppliedLesson, AppliedLessonsState, Task } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface AppliedLessonsCardProps {
	readonly task: Task;
}

const KIND_VARIANT = { rule: "info", pattern: "muted", checkpoint: "warning" } as const;

/**
 * « N leçons appliquées à cette tâche ».
 *
 * Ce que la boucle d'apprentissage a donné aux prompts de la tâche, lu dans
 * `applied_lessons.json` de chaque copie de la spec (le main fusionne) : les
 * règles adoptées en revue, les motifs appris des builds, et les points de
 * contrôle du type de tâche quand l'historique QA du dépôt les demande. Une
 * leçon se désactive pour cette tâche seulement ; les prompts suivants la
 * laissent de côté. Rien à montrer tant qu'aucun prompt n'a rien reçu.
 */
export function AppliedLessonsCard({ task }: AppliedLessonsCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [state, setState] = useState<AppliedLessonsState | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Read on open of the task, and again each time the list is opened: a
	// phase that started since may have carried new lessons.
	const load = useCallback((): (() => void) | undefined => {
		const api = globalThis.electronAPI;
		if (typeof api?.getAppliedLessons !== "function") return undefined;
		let cancelled = false;
		void api
			.getAppliedLessons(task.id)
			.then((result) => {
				if (!cancelled && result.success && result.data) setState(result.data);
			})
			.catch(() => {
				// No record is no card.
			});
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	useEffect(() => load(), [load]);

	if (!state || state.lessons.length === 0) return null;

	const disabled = new Set(state.disabled);
	const off = state.lessons.filter((lesson) => disabled.has(lesson.id)).length;

	const toggle = async (lesson: AppliedLesson) => {
		setBusy(lesson.id);
		setError(null);
		try {
			const result = await globalThis.electronAPI.setLessonDisabled(
				task.id,
				lesson.id,
				!disabled.has(lesson.id),
			);
			if (result.success && result.data) setState(result.data);
			else setError(t("tasks:appliedLessons.error", { error: result.error ?? "" }));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<GraduationCap className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">
							{t("tasks:appliedLessons.title", { count: state.lessons.length })}
						</span>
						{off > 0 && (
							<Badge variant="outline" className="text-3xs">
								{t("tasks:appliedLessons.disabledCount", { count: off })}
							</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground">{t("tasks:appliedLessons.description")}</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					aria-expanded={open}
					onClick={() => {
						if (!open) load();
						setOpen((prev) => !prev);
					}}
				>
					{open ? t("tasks:appliedLessons.hide") : t("tasks:appliedLessons.show")}
				</Button>
			</div>

			{open && (
				<ul className="mt-3 space-y-2">
					{state.lessons.map((lesson) => {
						const isOff = disabled.has(lesson.id);
						return (
							<li
								key={lesson.id}
								className={cn(
									"rounded-md border border-border bg-background p-2",
									isOff && "opacity-60",
								)}
							>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0 space-y-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<Badge variant={KIND_VARIANT[lesson.kind]} className="text-3xs">
												{t(`tasks:appliedLessons.kind.${lesson.kind}`)}
											</Badge>
											{lesson.patternType && (
												<span className="text-2xs text-muted-foreground">
													{t(`tasks:appliedLessons.patternType.${lesson.patternType}`, {
														defaultValue: lesson.patternType,
													})}
												</span>
											)}
											{typeof lesson.confidence === "number" && (
												<span className="text-2xs text-muted-foreground">
													{t("tasks:appliedLessons.confidence", {
														value: lesson.confidence.toFixed(2),
													})}
												</span>
											)}
											{isOff && (
												<span className="text-2xs font-medium text-warning">
													{t("tasks:appliedLessons.off")}
												</span>
											)}
										</div>
										<p className={cn("text-xs break-words", isOff && "line-through")}>{lesson.text}</p>
										{lesson.agents.length > 0 && (
											<p className="flex flex-wrap items-center gap-1 text-2xs text-muted-foreground">
												<span>{t("tasks:appliedLessons.agents")}</span>
												{lesson.agents.map((agent) => (
													<code key={agent} className="rounded bg-muted px-1">
														{agent}
													</code>
												))}
											</p>
										)}
									</div>
									<Button
										size="sm"
										variant="ghost"
										className="shrink-0 text-xs"
										disabled={busy !== null}
										title={isOff ? undefined : t("tasks:appliedLessons.disabledHint")}
										onClick={() => void toggle(lesson)}
									>
										{isOff ? t("tasks:appliedLessons.enable") : t("tasks:appliedLessons.disable")}
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
		</div>
	);
}
