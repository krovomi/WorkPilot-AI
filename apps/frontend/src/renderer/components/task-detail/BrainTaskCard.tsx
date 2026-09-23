import { Brain, Check, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import {
	type BrainNoteSummary,
	obsidianUri,
} from "../../lib/agent-tools-api";
import { useBrainStore } from "../../stores/brain-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface BrainTaskCardProps {
	readonly task: Task;
	/** Absolute project path: the brain files a task under its project's name. */
	readonly projectPath?: string;
}

/**
 * Ce que la tâche a appris au cerveau partagé.
 *
 * Le cerveau apprend à chaque build — la note de la tâche (demande, verdicts,
 * fichiers touchés) et ce que les agents y ont écrit en travaillant — mais
 * rien de cela ne se voyait dans l'application. Cette carte le montre, là où
 * l'on regarde une tâche.
 *
 * Trois décisions qu'elle assume :
 *
 * - **elle ne s'affiche que quand le cerveau a quelque chose de cette tâche**.
 *   Sans cerveau, ou sur une tâche pas encore construite, une carte « rien
 *   appris » serait une carte que personne ne lit ; la découverte se fait dans
 *   les Réglages ;
 * - **les règles proposées se tranchent ici**. Un agent de WorkPilot lit des
 *   issues, des PR, des pages web : il ne fait que *proposer* une règle, et
 *   une règle active s'applique à tous les agents de tous les projets. La
 *   décision revient à une personne, et le meilleur moment pour la prendre est
 *   devant la tâche qui l'a fait naître ;
 * - **« Ouvrir dans Obsidian » ouvre la note elle-même**, par son chemin : le
 *   cerveau est un vault, et c'est là qu'on la relit ou la corrige.
 */
export function BrainTaskCard({ task, projectPath }: BrainTaskCardProps) {
	const { t } = useTranslation(["brain"]);
	const [expanded, setExpanded] = useState(false);

	const loadTask = useBrainStore((s) => s.loadTask);
	const clearTask = useBrainStore((s) => s.clearTask);
	const setInstructionStatus = useBrainStore((s) => s.setInstructionStatus);
	const entry = useBrainStore((s) => s.byTask[task.id]);
	const learning = entry?.learning ?? null;

	const args = { taskId: task.id, projectDir: projectPath, specId: task.specId };

	useEffect(() => {
		if (!projectPath || !task.specId) return;
		void loadTask({ taskId: task.id, projectDir: projectPath, specId: task.specId });
		return () => clearTask(task.id);
	}, [task.id, task.specId, projectPath, loadTask, clearTask]);

	if (!learning?.active) return null;
	const { build, notes, proposals } = learning;
	if (!build && notes.length === 0) return null;

	const open = (note: BrainNoteSummary) =>
		void window.electronAPI.openExternal(obsidianUri(note.absPath));

	const verdict = (value: boolean | null | undefined, yes: string, no: string) =>
		value === null || value === undefined
			? t("brain:card.verdict.unknown")
			: t(value ? yes : no);

	return (
		<div className="rounded-lg border border-violet-500/40 bg-violet-500/5">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<Brain className="h-4 w-4 shrink-0 text-violet-500" aria-hidden />
						<span className="text-sm font-medium">{t("brain:card.title")}</span>
						{build && (
							<Badge variant="outline" className="text-[10px]">
								{t(
									build.status === "merged"
										? "brain:card.state.merged"
										: "brain:card.state.built",
								)}
							</Badge>
						)}
						{notes.length > 0 && (
							<Badge variant="outline" className="text-[10px]">
								{t("brain:card.badge.notes", { count: notes.length })}
							</Badge>
						)}
						{proposals.length > 0 && (
							<Badge
								variant="outline"
								className="border-amber-500/60 text-[10px] text-amber-600"
							>
								{t("brain:card.badge.proposals", { count: proposals.length })}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("brain:card.subtitle")}
					</p>
					{build && (
						<p className="mt-2 text-xs text-muted-foreground">
							{t("brain:card.verdict.qa", {
								value: verdict(
									build.qa,
									"brain:card.verdict.qaYes",
									"brain:card.verdict.qaNo",
								),
							})}
							{" · "}
							{t("brain:card.verdict.tests", {
								value: verdict(
									build.tests,
									"brain:card.verdict.testsYes",
									"brain:card.verdict.testsNo",
								),
							})}
						</p>
					)}
					{entry?.error && (
						<p className="mt-2 text-xs text-destructive" role="alert">
							{t("brain:card.error", { error: entry.error })}
						</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button size="sm" variant="ghost" onClick={() => void loadTask(args)}>
						{t("brain:card.refresh")}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
					>
						{expanded ? t("brain:card.collapse") : t("brain:card.expand")}
					</Button>
				</div>
			</div>

			{expanded && (
				<div className="space-y-3 border-t border-violet-500/20 p-3">
					{build && (
						<section>
							<h4 className="text-xs font-medium">{t("brain:card.buildNote")}</h4>
							<NoteRow note={build} onOpen={open} />
						</section>
					)}

					{proposals.length > 0 && (
						<section>
							<h4 className="text-xs font-medium">
								{t("brain:card.proposalsTitle")}
							</h4>
							<p className="mt-1 text-[10px] text-muted-foreground">
								{t("brain:card.proposalsHint")}
							</p>
							<ul className="mt-1 space-y-1">
								{proposals.map((proposal) => (
									<li
										key={proposal.path}
										className="flex items-center justify-between gap-2 text-xs"
									>
										<span className="min-w-0 truncate">{proposal.title}</span>
										<span className="flex shrink-0 gap-1">
											<Button
												size="sm"
												variant="outline"
												onClick={() =>
													void setInstructionStatus(args, proposal.path, "active")
												}
											>
												<Check className="mr-1 h-3 w-3" aria-hidden />
												{t("brain:card.activate")}
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													void setInstructionStatus(args, proposal.path, "retired")
												}
											>
												<X className="mr-1 h-3 w-3" aria-hidden />
												{t("brain:card.reject")}
											</Button>
										</span>
									</li>
								))}
							</ul>
						</section>
					)}

					<section>
						<h4 className="text-xs font-medium">{t("brain:card.notesTitle")}</h4>
						{notes.length === 0 ? (
							<p className="mt-1 text-xs text-muted-foreground">
								{t("brain:card.notesEmpty")}
							</p>
						) : (
							<ul className="mt-1 space-y-1">
								{notes.map((note) => (
									<li key={note.path}>
										<NoteRow note={note} onOpen={open} />
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			)}
		</div>
	);
}

function NoteRow({
	note,
	onOpen,
}: {
	note: BrainNoteSummary;
	onOpen: (note: BrainNoteSummary) => void;
}) {
	const { t } = useTranslation(["brain"]);
	const kind = ["instruction", "knowledge"].includes(note.kind) ? note.kind : "note";
	return (
		<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
			<span className="min-w-0 truncate">
				<span className="text-foreground">{note.title}</span>
				<Badge variant="outline" className="ml-2 text-[10px]">
					{t(`brain:card.kind.${kind}`)}
				</Badge>
				{note.agents.length > 0 && (
					<span className="ml-2 opacity-70">
						{t("brain:card.by", { agents: note.agents.join(", ") })}
					</span>
				)}
			</span>
			<Button
				size="sm"
				variant="ghost"
				className="shrink-0"
				onClick={() => onOpen(note)}
				title={note.path}
			>
				<ExternalLink className="mr-1 h-3 w-3" aria-hidden />
				{t("brain:card.openInObsidian")}
			</Button>
		</div>
	);
}
