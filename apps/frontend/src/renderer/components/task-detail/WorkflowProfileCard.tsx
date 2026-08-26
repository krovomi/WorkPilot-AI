import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	CircleDashed,
	Lock,
	MinusCircle,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import type {
	WorkflowLevelPayload,
	WorkflowPhasePayload,
} from "../../lib/agent-tools-api";
import { useWorkflowProfileStore } from "../../stores/workflow-profile-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const EFFORT_LEVELS = ["low", "medium", "high", "ultrathink"] as const;

export interface WorkflowProfileCardProps {
	readonly task: Task;
	/** Absolute project path; the server derives the spec directory from it. */
	readonly projectPath?: string;
}

/**
 * Le profil d'exécution résolu, affiché avant le build.
 *
 * Le Chantier 4 veut que l'utilisateur voie ce que son niveau d'effort achète
 * *avant* d'exécuter, pas qu'il le déduise d'un log après coup — et jusqu'ici
 * ce profil n'était imprimé que dans un terminal que l'utilisateur du Kanban
 * n'ouvre jamais.
 *
 * Trois choses que la bannière rend visibles et qui n'existaient nulle part
 * dans l'UI :
 *
 * - les phases **sautées** restent affichées, à leur place déclarée, avec la
 *   raison. Une liste qui ne montre que ce qui survit ne peut pas répondre à
 *   « qu'est-ce que j'aurais pour un niveau de plus », qui est exactement la
 *   question qu'on se pose devant un sélecteur d'effort ;
 * - une phase **dégradée** par le provider le dit, au lieu de prétendre
 *   dispatcher ;
 * - une porte dure ou déterministe porte son étiquette : elle ne se négocie
 *   pas, quel que soit le budget.
 */
export function WorkflowProfileCard({
	task,
	projectPath,
}: WorkflowProfileCardProps) {
	const { t } = useTranslation(["workflowProfile"]);
	const [expanded, setExpanded] = useState(false);

	const load = useWorkflowProfileStore((s) => s.load);
	const clear = useWorkflowProfileStore((s) => s.clear);
	const entry = useWorkflowProfileStore((s) => s.byTask[task.id]);

	const profile = entry?.profile ?? null;
	const previewEffort = entry?.previewEffort ?? null;

	useEffect(() => {
		if (!projectPath) return;
		void load({
			taskId: task.id,
			specDir: task.specsPath,
			projectDir: projectPath,
			specId: task.specId,
			provider: task.metadata?.provider,
		});
		return () => clear(task.id);
	}, [
		task.id,
		task.specId,
		task.specsPath,
		task.metadata?.provider,
		projectPath,
		load,
		clear,
	]);

	const running = useMemo(
		() => (profile?.phases ?? []).filter((p) => p.runs),
		[profile],
	);

	if (!projectPath) return null;
	if (entry?.loading && profile === null) {
		return (
			<div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
				{t("workflowProfile:loading")}
			</div>
		);
	}
	if (entry?.error && profile === null) {
		return (
			<div className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
				{t("workflowProfile:error", { error: entry.error })}
			</div>
		);
	}
	if (profile === null) return null;

	const currentLevel = profile.levels?.find((l) => l.effort === profile.effort);

	return (
		<div className="rounded-lg border border-border bg-muted/20">
			<div className="flex items-start justify-between gap-3 p-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<Zap className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
						<span className="text-sm font-medium">
							{t("workflowProfile:title")}
						</span>
						<Badge variant="outline" className="text-[10px]">
							{profile.workflow}
						</Badge>
						{previewEffort !== null && (
							<Badge className="text-[10px]">
								{t("workflowProfile:levels.preview")}
							</Badge>
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("workflowProfile:subtitle")}
					</p>
					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span>
							{t("workflowProfile:summary.effort")}:{" "}
							<span className="font-medium text-foreground">
								{profile.effort}
							</span>
						</span>
						<span>
							{t("workflowProfile:summary.provider")}:{" "}
							<span className="font-medium text-foreground">
								{profile.provider ??
									t("workflowProfile:summary.providerUnset")}
							</span>
						</span>
						<span>
							{t("workflowProfile:summary.phases", {
								count: running.length,
								total: profile.phases.length,
							})}
						</span>
					</div>
				</div>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					{expanded ? (
						<ChevronDown className="mr-1 h-3 w-3" aria-hidden />
					) : (
						<ChevronRight className="mr-1 h-3 w-3" aria-hidden />
					)}
					{expanded
						? t("workflowProfile:collapse")
						: t("workflowProfile:expand")}
				</Button>
			</div>

			{profile.enabled === false && (
				<div className="mx-3 mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
					<div className="font-medium">
						{t("workflowProfile:disabled.title")}
					</div>
					<div className="text-muted-foreground">
						{t("workflowProfile:disabled.body")}
					</div>
				</div>
			)}

			{profile.missing.length > 0 && (
				<div className="mx-3 mb-3 flex items-start gap-2 rounded border border-border bg-background/50 p-2 text-xs">
					<AlertTriangle
						className="mt-0.5 h-3 w-3 shrink-0 text-amber-500"
						aria-hidden
					/>
					<div>
						<div className="font-medium">
							{t("workflowProfile:missing.title")}
						</div>
						<div className="text-muted-foreground">
							{t("workflowProfile:missing.body", {
								count: profile.missing.length,
							})}
						</div>
					</div>
				</div>
			)}

			{expanded && (
				<div className="border-t border-border">
					<ol className="divide-y divide-border/60">
						{profile.phases.map((phase) => (
							<PhaseRow key={phase.id} phase={phase} />
						))}
					</ol>
					<LevelComparison
						levels={profile.levels ?? []}
						current={currentLevel}
						taskEffort={profile.effort}
						onPreview={(effort) =>
							void load({
								taskId: task.id,
								specDir: task.specsPath,
								projectDir: projectPath,
								specId: task.specId,
								provider: task.metadata?.provider,
								effort: effort ?? undefined,
							})
						}
						isPreviewing={previewEffort !== null}
					/>
				</div>
			)}
		</div>
	);
}

function PhaseRow({ phase }: { readonly phase: WorkflowPhasePayload }) {
	const { t } = useTranslation(["workflowProfile"]);

	const skipDetail =
		phase.skipReason === "effort"
			? t("workflowProfile:phase.skippedByEffort", {
					minEffort: phase.minEffort,
				})
			: phase.skipReason === "untouched"
				? t("workflowProfile:phase.skippedUntouched")
				: null;

	const dispatchLabel = t(
		`workflowProfile:phase.dispatch.${phase.dispatch}`,
		phase.dispatch,
	);

	return (
		<li
			className={`flex items-start gap-2 px-3 py-2 text-xs ${
				phase.runs ? "" : "opacity-55"
			}`}
		>
			<span className="mt-0.5 shrink-0" aria-hidden>
				{phase.runs ? (
					phase.hardGate ? (
						<Lock className="h-3 w-3 text-emerald-600" />
					) : (
						<CircleDashed className="h-3 w-3 text-emerald-600" />
					)
				) : (
					<MinusCircle className="h-3 w-3 text-muted-foreground" />
				)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium">{phase.id}</span>
					<span className="text-muted-foreground">{phase.impl}</span>
					{phase.dispatch !== "inline" && (
						<Badge variant="outline" className="text-[10px]">
							{dispatchLabel}
						</Badge>
					)}
					{phase.hardGate && (
						<Badge variant="outline" className="text-[10px]">
							{t("workflowProfile:phase.hardGate", { gate: phase.hardGate })}
						</Badge>
					)}
					{phase.deterministic && (
						<Badge variant="outline" className="text-[10px]">
							{t("workflowProfile:phase.deterministic")}
						</Badge>
					)}
					{phase.gate === "human" && (
						<Badge variant="outline" className="text-[10px]">
							{t("workflowProfile:phase.humanGate")}
						</Badge>
					)}
				</div>
				{phase.degradedFrom && (
					<div className="mt-0.5 text-amber-600 dark:text-amber-400">
						{t("workflowProfile:phase.degraded", {
							from: phase.degradedFrom,
							reason: phase.degradedReason,
						})}
					</div>
				)}
				{skipDetail && (
					<div className="mt-0.5 text-muted-foreground">{skipDetail}</div>
				)}
				{phase.runs && phase.conditional && (
					<div className="mt-0.5 text-muted-foreground">
						{t("workflowProfile:phase.conditional", {
							globs: phase.whenGlobs.join(", "),
						})}
					</div>
				)}
			</div>
		</li>
	);
}

function LevelComparison({
	levels,
	current,
	taskEffort,
	onPreview,
	isPreviewing,
}: {
	readonly levels: WorkflowLevelPayload[];
	readonly current: WorkflowLevelPayload | undefined;
	readonly taskEffort: string;
	readonly onPreview: (effort: string | null) => void;
	readonly isPreviewing: boolean;
}) {
	const { t } = useTranslation(["workflowProfile"]);
	if (levels.length === 0) return null;

	const baseline = current?.count ?? 0;

	return (
		<div className="border-t border-border px-3 py-2">
			<div className="mb-1.5 text-xs font-medium">
				{t("workflowProfile:levels.title")}
			</div>
			<div className="flex flex-wrap gap-1.5">
				{EFFORT_LEVELS.map((level) => {
					const row = levels.find((l) => l.effort === level);
					if (!row) return null;
					const delta = row.count - baseline;
					const isCurrent = level === taskEffort;
					const label =
						delta === 0
							? t("workflowProfile:levels.same")
							: delta > 0
								? t("workflowProfile:levels.adds", { count: delta })
								: t("workflowProfile:levels.removes", { count: -delta });
					return (
						<button
							key={level}
							type="button"
							onClick={() => onPreview(level)}
							className={`rounded border px-2 py-1 text-[11px] transition-colors ${
								isCurrent
									? "border-primary/60 bg-primary/10"
									: "border-border hover:bg-muted"
							}`}
						>
							<span className="font-medium">{level}</span>
							<span className="ml-1 text-muted-foreground">
								{isCurrent ? t("workflowProfile:levels.current") : label}
							</span>
						</button>
					);
				})}
			</div>
			{isPreviewing && (
				<Button
					size="sm"
					variant="ghost"
					className="mt-1.5 h-6 px-2 text-[11px]"
					onClick={() => onPreview(null)}
				>
					{t("workflowProfile:levels.backToTask")}
				</Button>
			)}
		</div>
	);
}
