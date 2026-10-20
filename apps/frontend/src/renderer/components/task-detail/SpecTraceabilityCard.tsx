import { CircleHelp, ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { useSpecTraceabilityStore } from "../../stores/spec-traceability-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface SpecTraceabilityCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
}

/**
 * Ce que le spec laisse ouvert, et ce que le plan ne construira pas.
 *
 * Deux signaux qui existaient dans les fichiers et nulle part dans l'UI :
 *
 * - les marqueurs `[NEEDS CLARIFICATION]` — une hypothèse que le rédacteur du
 *   spec a dû prendre faute de réponse. Dans le document fini, une supposition
 *   se lit exactement comme une décision ; ici elle porte son étiquette, et la
 *   personne qui relit avant de lancer le build est la seule à pouvoir la
 *   trancher ;
 * - les exigences qu'**aucune** subtask ne réclame. C'est la question à
 *   laquelle personne ne pouvait répondre avant la QA, c'est-à-dire après que
 *   le code a été écrit contre un plan incomplet.
 *
 * La carte ne s'affiche que quand elle a quelque chose à dire : un spec sans
 * identifiants ni marqueur ne mérite pas une ligne « rien à signaler ». Un
 * badge permanent qui est vert 95 % du temps est un badge que personne ne lit.
 */
export function SpecTraceabilityCard({
	task,
	projectPath,
}: SpecTraceabilityCardProps) {
	const { t } = useTranslation(["traceability"]);
	const [expanded, setExpanded] = useState(false);

	const load = useSpecTraceabilityStore((s) => s.load);
	const clear = useSpecTraceabilityStore((s) => s.clear);
	const entry = useSpecTraceabilityStore((s) => s.byTask[task.id]);
	const data = entry?.traceability ?? null;

	useEffect(() => {
		if (!projectPath) return;
		void load({
			taskId: task.id,
			specDir: task.specsPath,
			projectDir: projectPath,
			specId: task.specId,
		});
		return () => clear(task.id);
	}, [task.id, task.specId, task.specsPath, projectPath, load, clear]);

	if (!projectPath || data === null) return null;

	const questions = data.openQuestions;
	const { coverage } = data;
	const uncovered = coverage.applicable ? coverage.uncovered : [];
	const unknown = coverage.applicable ? Object.keys(coverage.unknownRefs) : [];

	// Nothing open and nothing unclaimed: the spec and the plan agree, and a
	// card saying so is a card in the way.
	if (questions.length === 0 && uncovered.length === 0 && unknown.length === 0) {
		return null;
	}

	return (
		<div className="rounded-lg border border-amber-500/40 bg-amber-500/5">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<ListChecks
							className="h-4 w-4 shrink-0 text-amber-500"
							aria-hidden
						/>
						<span className="text-sm font-medium">
							{t("traceability:title")}
						</span>
						{questions.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("traceability:badge.questions", {
									count: questions.length,
								})}
							</Badge>
						)}
						{uncovered.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("traceability:badge.uncovered", {
									count: uncovered.length,
								})}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("traceability:subtitle")}
					</p>
					{coverage.applicable && (
						<p className="mt-2 text-xs text-muted-foreground">
							{t("traceability:coverage.summary", {
								covered: data.requirements.length - coverage.uncovered.length,
								total: data.requirements.length,
								percent: coverage.percent ?? 0,
							})}
						</p>
					)}
				</div>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					{expanded ? t("traceability:collapse") : t("traceability:expand")}
				</Button>
			</div>

			{expanded && (
				<div className="border-t border-amber-500/20 p-3 space-y-3">
					{questions.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("traceability:questions.title")}
							</h4>
							<ul className="mt-1 space-y-1">
								{questions.map((q) => (
									<li
										key={`${q.line}-${q.question}`}
										className="flex items-start gap-2 text-xs text-muted-foreground"
									>
										<CircleHelp
											className="mt-0.5 h-3 w-3 shrink-0 text-amber-500"
											aria-hidden
										/>
										<span>
											{q.question || t("traceability:questions.unspecified")}
											{q.section && (
												<span className="ml-1 opacity-70">({q.section})</span>
											)}
										</span>
									</li>
								))}
							</ul>
						</section>
					)}

					{uncovered.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("traceability:uncovered.title")}
							</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("traceability:uncovered.body")}
							</p>
							<div className="mt-1 flex flex-wrap gap-1">
								{uncovered.map((id) => (
									<Badge key={id} variant="outline" className="text-[10px]">
										{id}
									</Badge>
								))}
							</div>
						</section>
					)}

					{unknown.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("traceability:unknown.title")}
							</h4>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("traceability:unknown.body")}
							</p>
							<div className="mt-1 flex flex-wrap gap-1">
								{unknown.map((id) => (
									<Badge key={id} variant="outline" className="text-[10px]">
										{id}
									</Badge>
								))}
							</div>
						</section>
					)}
				</div>
			)}
		</div>
	);
}
