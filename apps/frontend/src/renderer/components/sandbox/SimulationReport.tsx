import { AlertTriangle, Box, Eye, FileDiff, ListChecks, Play, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "../../stores/project-store";
import { useSandboxStore } from "../../stores/sandbox-store";
import { useTaskStore } from "../../stores/task-store";
import type { SandboxMode, SimulationResult, StepStatus } from "../../../shared/types/sandbox";
import {
	CharterButton,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	Tabs,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DiffPreview } from "./DiffPreview";
import { PlanRehearsalReport } from "./PlanRehearsalReport";

const STEP_TONES: Record<StepStatus, Tone> = {
	success: "green",
	warning: "amber",
	error: "red",
	skipped: "muted",
};

interface SimulationReportProps {
	readonly projectPath?: string;
}

/** The specs of the active project, from its loaded tasks, with their base branch. */
function useProjectSpecs(): Array<{ id: string; title: string; baseBranch?: string }> {
	const tasks = useTaskStore((s) => s.tasks);
	const projectId = useProjectStore((s) => s.activeProjectId || s.selectedProjectId);
	return useMemo(() => {
		const seen = new Map<string, { id: string; title: string; baseBranch?: string }>();
		for (const task of tasks) {
			if (projectId && task.projectId !== projectId) continue;
			if (task.specId && !seen.has(task.specId)) {
				seen.set(task.specId, {
					id: task.specId,
					title: task.title || task.specId,
					baseBranch: task.metadata?.baseBranch,
				});
			}
		}
		return Array.from(seen.values()).sort((a, b) => a.id.localeCompare(b.id));
	}, [tasks, projectId]);
}

/**
 * The sandbox: the uncommitted changes of the project before a commit, or the
 * rehearsal of a spec's plan before its build spends a token.
 */
export function SimulationReport({ projectPath }: SimulationReportProps): React.ReactElement {
	const { t } = useTranslation(["sandbox", "navigation"]);
	const [mode, setMode] = useState<SandboxMode>("plan");
	const specs = useProjectSpecs();
	const selectedTaskId = useTaskStore((s) => s.selectedTaskId);
	const selectedSpec = useTaskStore((s) => s.tasks.find((task) => task.id === selectedTaskId)?.specId);
	const [specId, setSpecId] = useState("");
	const [baseRef, setBaseRef] = useState("");

	// Keep the choice inside the list: the selected task's spec, else the first.
	useEffect(() => {
		if (specId && specs.some((s) => s.id === specId)) return;
		const preferred = specs.find((s) => s.id === selectedSpec)?.id ?? specs[0]?.id ?? "";
		if (preferred !== specId) setSpecId(preferred);
	}, [specs, specId, selectedSpec]);

	const spec = specs.find((s) => s.id === specId);

	const phase = useSandboxStore((s) => s.phase);
	const status = useSandboxStore((s) => s.status);
	const result = useSandboxStore((s) => s.result);
	const error = useSandboxStore((s) => s.error);
	const startScan = useSandboxStore((s) => s.startScan);
	const cancelScan = useSandboxStore((s) => s.cancelScan);
	const reset = useSandboxStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const shown = result && (result.mode ?? "changes") === mode ? result : null;
	const canRun = Boolean(projectPath) && (mode === "changes" || Boolean(spec));
	const run = () => {
		if (!projectPath) return;
		if (mode === "changes") void startScan(projectPath);
		else if (spec) void startScan(projectPath, { specId: spec.id, baseRef: baseRef.trim() || spec.baseBranch });
	};

	return (
		<ModuleStage data-testid="sandbox-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("sandbox:title")}
				description={t("sandbox:description")}
				icon={Box}
				tone="violet"
				actions={
					<>
						{phase === "complete" && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("sandbox:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => void cancelScan()}>
								{t("sandbox:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={mode === "plan" ? Play : Eye}
								onClick={run}
								disabled={!canRun}
								data-testid="sandbox-run"
							>
								{t(mode === "plan" ? "sandbox:actions.runPlan" : "sandbox:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>

			<div className="relative z-[1] flex flex-wrap items-end gap-3 px-6 pt-3">
				<Tabs
					label={t("sandbox:title")}
					tabs={[
						{ id: "plan", label: t("sandbox:modes.plan"), icon: ListChecks },
						{ id: "changes", label: t("sandbox:modes.changes"), icon: FileDiff },
					]}
					value={mode}
					onChange={(next) => {
						setMode(next);
						if (!isScanning) reset();
					}}
				/>
				{mode === "plan" && (
					<>
						<div className="min-w-[16rem]">
							<Label className="wp-kicker mb-1 block" htmlFor="sandbox-spec">
								{t("sandbox:plan.spec")}
							</Label>
							<Select value={specId} onValueChange={setSpecId} disabled={specs.length === 0 || isScanning}>
								<SelectTrigger id="sandbox-spec" data-testid="sandbox-spec-select">
									<SelectValue placeholder={t(specs.length === 0 ? "sandbox:plan.noSpecs" : "sandbox:plan.selectSpec")} />
								</SelectTrigger>
								<SelectContent searchable={specs.length > 8}>
									{specs.map((s) => (
										<SelectItem key={s.id} value={s.id}>
											{s.title === s.id ? s.id : `${s.title} (${s.id})`}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="w-40">
							<Label className="wp-kicker mb-1 block" htmlFor="sandbox-ref">
								{t("sandbox:plan.baseRef")}
							</Label>
							<Input
								id="sandbox-ref"
								value={baseRef}
								placeholder={spec?.baseBranch || "HEAD"}
								onChange={(e) => setBaseRef(e.target.value)}
								disabled={isScanning}
							/>
						</div>
					</>
				)}
			</div>

			{phase === "complete" && shown && shown.mode === "plan" ? (
				<PlanRehearsalReport key={shown.id} result={shown} />
			) : phase === "complete" && shown && shown.diffs.length > 0 ? (
				<DiffPreview key={shown.id} diffs={shown.diffs} aside={<RunSummary result={shown} />} />
			) : (
				<div className="relative z-[1] flex flex-1 flex-col items-center justify-center gap-3 p-8">
					{!projectPath && (
						<Notice tone="amber" icon={AlertTriangle}>
							{t("sandbox:errors.noProject")}
						</Notice>
					)}
					{isScanning && <ScanLine label={status || t("sandbox:actions.scanning")} />}
					{phase === "error" && error && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{t("sandbox:errors.failed", { error })}
						</Notice>
					)}
					{!isScanning && (
						<EmptyStage
							icon={mode === "plan" ? ListChecks : Box}
							tone="violet"
							title={
								mode === "plan"
									? t("sandbox:plan.emptyTitle")
									: t(phase === "complete" && shown ? "sandbox:noChanges" : "sandbox:noData")
							}
						>
							{t(mode === "plan" ? "sandbox:plan.emptyBody" : "sandbox:emptyBody")}
						</EmptyStage>
					)}
				</div>
			)}
		</ModuleStage>
	);
}

/** Steps, warnings and cost only exist when a run produced the changes. */
function RunSummary({ result }: { readonly result: SimulationResult }): React.ReactElement | null {
	const { t } = useTranslation("sandbox");
	if (result.steps.length === 0) return null;
	return (
		<div className="mb-3 space-y-2.5">
			<Stats>
				<Stat label={t("steps")} value={`${result.successCount}/${result.steps.length}`} tone="green" />
				<Stat label={t("warnings")} value={result.warningCount} tone={result.warningCount ? "amber" : "muted"} />
				<Stat label={t("cost")} value={`$${result.estimatedCostUsd.toFixed(4)}`} tone="blue" />
			</Stats>
			{result.steps.map((step) => (
				<Panel key={step.index} rail tone={STEP_TONES[step.status]}>
					<p className="text-sm">{step.description}</p>
					<p className="wp-meta mt-1">
						{t("durationAndTokens", { duration: step.durationMs, tokens: step.tokensUsed })}
					</p>
				</Panel>
			))}
		</div>
	);
}
