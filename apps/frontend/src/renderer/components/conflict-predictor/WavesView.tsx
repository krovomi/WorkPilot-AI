/**
 * Execution waves across specs (#358): the waves the main process planned,
 * a Gantt-like layout by wave (no duration: the waves run one after the
 * other), the merge order, the riskiest pairs, and "Execute in optimal order",
 * which starts wave after wave through the ordinary task start path.
 */

import { AlertTriangle, GitMerge, Layers, Play, RefreshCw, Square } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ExecutionWavePlan, WaveRiskLevel } from "../../../shared/types/conflict-waves";
import { useExecutionWavesStore } from "../../stores/execution-waves-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	Chips,
	EmptyStage,
	Notice,
	Panel,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";

const TOLERANCES = [0, 1, 2, 4] as const;
const MAX_PAIRS = 10;

const LEVEL_TONE: Record<WaveRiskLevel, Tone> = {
	none: "muted",
	low: "blue",
	medium: "amber",
	high: "orange",
	critical: "red",
};

function useTitles(plan: ExecutionWavePlan | null): (id: string) => string {
	return useMemo(() => {
		const titles = new Map((plan?.tasks ?? []).map((t) => [t.taskId, t.title || t.taskId]));
		return (id: string) => titles.get(id) ?? id;
	}, [plan]);
}

export function WavesView() {
	const { t } = useTranslation(["conflictPredictor", "common"]);
	const projectId = useProjectStore((s) => s.selectedProjectId);
	const { plan, isPlanning, error, options, execution, blocked, startFailures } =
		useExecutionWavesStore(
			useShallow((s) => ({
				plan: s.plan,
				isPlanning: s.isPlanning,
				error: s.error,
				options: s.options,
				execution: s.execution,
				blocked: s.blocked,
				startFailures: s.startFailures,
			})),
		);
	const { setOptions, computePlan, execute, stop } = useExecutionWavesStore(
		useShallow((s) => ({
			setOptions: s.setOptions,
			computePlan: s.computePlan,
			execute: s.execute,
			stop: s.stop,
		})),
	);
	const title = useTitles(plan);
	const shownPlan = plan && plan.projectId === projectId ? plan : null;
	const running = execution?.status === "running" && execution.projectId === projectId;
	const names = (ids: readonly string[]) => ids.map(title).join(", ");

	const actions = (
		<>
			<CharterButton
				icon={RefreshCw}
				busy={isPlanning}
				disabled={!projectId || isPlanning}
				onClick={() => projectId && void computePlan(projectId)}
			>
				{shownPlan ? t("conflictPredictor:waves.actions.replan") : t("conflictPredictor:waves.actions.plan")}
			</CharterButton>
			{running ? (
				<CharterButton icon={Square} variant="danger" onClick={stop}>
					{t("conflictPredictor:waves.actions.stop")}
				</CharterButton>
			) : (
				<CharterButton
					icon={Play}
					disabled={!shownPlan || shownPlan.waves.length === 0 || isPlanning}
					onClick={() => void execute()}
				>
					{t("conflictPredictor:waves.actions.execute")}
				</CharterButton>
			)}
		</>
	);

	return (
		<Section
			kicker={t("conflictPredictor:waves.kicker")}
			title={t("conflictPredictor:waves.title")}
			description={t("conflictPredictor:waves.description")}
			actions={actions}
		>
			<div className="space-y-3" data-testid="execution-waves">
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<span className="wp-meta">{t("conflictPredictor:waves.options.tolerance")}</span>
					<Chips>
						{TOLERANCES.map((value) => (
							<Chip
								key={value}
								dot={false}
								pressed={options.tolerance === value}
								title={t("conflictPredictor:waves.options.toleranceHint")}
								onClick={() => setOptions({ tolerance: value })}
							>
								{t(`conflictPredictor:waves.options.toleranceValue_${value}`)}
							</Chip>
						))}
					</Chips>
					<span className="wp-meta">{t("conflictPredictor:waves.options.unplanned")}</span>
					<Chips>
						<Chip
							dot={false}
							pressed={options.unplannedPolicy === "isolate"}
							onClick={() => setOptions({ unplannedPolicy: "isolate" })}
						>
							{t("conflictPredictor:waves.options.unplannedIsolate")}
						</Chip>
						<Chip
							dot={false}
							pressed={options.unplannedPolicy === "independent"}
							onClick={() => setOptions({ unplannedPolicy: "independent" })}
						>
							{t("conflictPredictor:waves.options.unplannedIndependent")}
						</Chip>
					</Chips>
					<span className="wp-meta">{t("conflictPredictor:waves.options.advance")}</span>
					<Chips>
						<Chip
							dot={false}
							pressed={options.advanceWhen === "merged"}
							onClick={() => setOptions({ advanceWhen: "merged" })}
						>
							{t("conflictPredictor:waves.options.advanceMerged")}
						</Chip>
						<Chip
							dot={false}
							pressed={options.advanceWhen === "review"}
							onClick={() => setOptions({ advanceWhen: "review" })}
						>
							{t("conflictPredictor:waves.options.advanceReview")}
						</Chip>
					</Chips>
				</div>

				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("conflictPredictor:waves.notices.error", { error })}
					</Notice>
				)}

				{execution && execution.projectId === projectId && (
					<Notice tone={execution.status === "running" ? "blue" : "muted"} role="status">
						{execution.status === "done"
							? t("conflictPredictor:waves.run.done")
							: t(`conflictPredictor:waves.run.${execution.status}`, {
									current: execution.current + 1,
									total: execution.waves.length,
								})}
					</Notice>
				)}
				{running && blocked.length > 0 && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("conflictPredictor:waves.run.blocked", { tasks: names(blocked) })}
					</Notice>
				)}
				{Object.entries(startFailures).map(([taskId, reason]) => (
					<Notice key={taskId} tone="red" icon={AlertTriangle}>
						{t("conflictPredictor:waves.run.startFailed", { task: title(taskId), error: reason })}
					</Notice>
				))}

				{!projectId ? (
					<EmptyStage icon={Layers} tone="orange" title={t("conflictPredictor:waves.empty.noProject")} />
				) : !shownPlan ? (
					<EmptyStage icon={Layers} tone="orange" title={t("conflictPredictor:waves.empty.noPlan")} />
				) : (
					<PlanBody plan={shownPlan} title={title} execution={running ? execution : null} />
				)}
			</div>
		</Section>
	);
}

interface PlanBodyProps {
	plan: ExecutionWavePlan;
	title: (id: string) => string;
	execution: { current: number; waves: string[][] } | null;
}

function PlanBody({ plan, title, execution }: PlanBodyProps) {
	const { t } = useTranslation(["conflictPredictor"]);
	const names = (ids: readonly string[]) => ids.map(title).join(", ");
	const byId = new Map(plan.tasks.map((task) => [task.taskId, task]));
	const unplanned = plan.order.filter((id) => byId.get(id)?.planned === false);
	const cyclic = plan.excluded.filter((e) => e.reason === "cycle").map((e) => e.taskId);
	const behindCycle = plan.excluded.filter((e) => e.reason === "blocked_by_cycle").map((e) => e.taskId);
	const avoided = Math.max(0, plan.totalRisk - plan.residualRisk);
	const waveCount = plan.waves.length;

	if (plan.order.length === 0 && plan.excluded.length === 0) {
		return <EmptyStage icon={Layers} tone="orange" title={t("conflictPredictor:waves.empty.noTasks")} />;
	}

	return (
		<div className="space-y-3">
			<Stats>
				<Stat label={t("conflictPredictor:waves.stats.specs")} value={String(plan.order.length)} tone="blue" />
				<Stat label={t("conflictPredictor:waves.stats.waves")} value={String(waveCount)} tone="violet" />
				<Stat label={t("conflictPredictor:waves.stats.parallel")} value={String(plan.maxParallel)} tone="orange" />
				<Stat
					label={t("conflictPredictor:waves.stats.avoided")}
					value={t("conflictPredictor:waves.stats.avoidedValue", { avoided, total: plan.totalRisk })}
					tone="green"
				/>
			</Stats>

			{cyclic.length > 0 && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("conflictPredictor:waves.notices.cycle", { tasks: names(cyclic) })}
				</Notice>
			)}
			{behindCycle.length > 0 && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("conflictPredictor:waves.notices.blockedByCycle", { tasks: names(behindCycle) })}
				</Notice>
			)}
			{plan.drift.map((d) => (
				<Notice key={d.taskId} tone="amber" icon={AlertTriangle}>
					{t("conflictPredictor:waves.notices.drift", { task: title(d.taskId), count: d.extraCount })}
				</Notice>
			))}
			{plan.runningConflicts.map((c) => (
				<Notice key={`${c.taskId}-${c.runningTaskId}`} tone="amber" icon={AlertTriangle}>
					{t("conflictPredictor:waves.notices.runningConflict", {
						task: title(c.taskId),
						running: title(c.runningTaskId),
					})}
				</Notice>
			))}
			{unplanned.length > 0 && (
				<Notice tone="muted">
					{t("conflictPredictor:waves.notices.unplanned", { count: unplanned.length })}
				</Notice>
			)}

			{waveCount > 0 && (
				<Panel>
					<p className="wp-kicker mb-2">{t("conflictPredictor:waves.gantt.kicker")}</p>
					<div className="overflow-x-auto">
						<table className="w-full table-fixed border-separate border-spacing-1" aria-label={t("conflictPredictor:waves.gantt.title")}>
							<colgroup>
								<col className="w-40" />
								{plan.waves.map((wave) => (
									<col key={wave.index} />
								))}
							</colgroup>
							<thead>
								<tr>
									<th scope="col" className="wp-meta text-left font-normal">
										{t("conflictPredictor:waves.gantt.task")}
									</th>
									{plan.waves.map((wave) => (
										<th key={wave.index} scope="col" className="wp-meta text-center font-normal">
											{t("conflictPredictor:waves.waveLabel", { index: wave.index })}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{plan.waves.flatMap((wave) =>
									wave.taskIds.map((id) => (
										<GanttRow
											key={id}
											label={title(id)}
											column={wave.index}
											waveCount={waveCount}
											state={waveState(execution, plan, wave.index)}
										/>
									)),
								)}
							</tbody>
						</table>
					</div>
					<p className="wp-meta mt-2">{t("conflictPredictor:waves.gantt.legend")}</p>
				</Panel>
			)}

			{waveCount > 0 && (
				<div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
					{plan.waves.map((wave) => (
						<Panel key={wave.index} rail tone="violet" data-testid={`wave-${wave.index}`}>
							<div className="mb-2 flex flex-wrap items-center gap-2">
								<span className="wp-title text-sm">
									{t("conflictPredictor:waves.waveLabel", { index: wave.index })}
								</span>
								{wave.residualRisk > 0 && (
									<Chip tone="amber">{t("conflictPredictor:waves.residual", { value: wave.residualRisk })}</Chip>
								)}
							</div>
							<ol className="space-y-1">
								{wave.taskIds.map((id) => {
									const task = byId.get(id);
									return (
										<li key={id} className="flex flex-wrap items-center gap-2 text-sm">
											<GitMerge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
											<span className="min-w-0 truncate">{title(id)}</span>
											{task?.planned === false ? (
												<Chip tone="muted">{t("conflictPredictor:waves.unplannedChip")}</Chip>
											) : (
												<span className="wp-meta">
													{t("conflictPredictor:waves.files", { count: task?.fileCount ?? 0 })}
												</span>
											)}
										</li>
									);
								})}
							</ol>
						</Panel>
					))}
				</div>
			)}
			{waveCount > 0 && <p className="wp-meta">{t("conflictPredictor:waves.list.mergeHint")}</p>}

			{plan.pairs.length > 0 && (
				<Panel>
					<p className="wp-kicker mb-2">{t("conflictPredictor:waves.pairs.title")}</p>
					<ul className="space-y-1">
						{plan.pairs.slice(0, MAX_PAIRS).map((pair) => (
							<li key={`${pair.a}-${pair.b}`} className="flex flex-wrap items-center gap-2 text-sm">
								<Chip tone={LEVEL_TONE[pair.level]}>{String(pair.score)}</Chip>
								<span className="min-w-0 truncate">{names([pair.a, pair.b])}</span>
								<span className="wp-meta">
									{pair.unknown
										? t("conflictPredictor:waves.pairs.unknown")
										: t("conflictPredictor:waves.pairs.shared", { count: pair.sharedFiles.length })}
								</span>
								{!pair.blocking && <Chip tone="green">{t("conflictPredictor:waves.pairs.together")}</Chip>}
							</li>
						))}
					</ul>
				</Panel>
			)}
		</div>
	);
}

type BarState = "pending" | "current" | "finished";

function waveState(
	execution: { current: number; waves: string[][] } | null,
	plan: ExecutionWavePlan,
	index: number,
): BarState {
	if (!execution) return "pending";
	// After a re-plan the shown plan holds the remaining waves only.
	const offset = execution.waves.length - plan.waves.length;
	const absolute = index - 1 + offset;
	if (absolute < execution.current) return "finished";
	if (absolute === execution.current) return "current";
	return "pending";
}

function GanttRow({
	label,
	column,
	waveCount,
	state,
}: {
	label: string;
	column: number;
	waveCount: number;
	state: BarState;
}) {
	const { t } = useTranslation(["conflictPredictor"]);
	const background =
		state === "finished"
			? "var(--wp-faint)"
			: state === "current"
				? "var(--wp-accent, currentColor)"
				: "color-mix(in srgb, var(--wp-accent, currentColor) 45%, transparent)";
	return (
		<tr>
			<th scope="row" className="truncate text-left text-sm font-normal">
				{label}
			</th>
			{Array.from({ length: waveCount }, (_, i) => i + 1).map((index) => (
				<td key={index} data-state={index === column ? state : undefined}>
					{index === column && (
						<div
							className="h-5 rounded-sm"
							style={{ background }}
							title={state === "pending" ? undefined : t(`conflictPredictor:waves.run.${state}`)}
						/>
					)}
				</td>
			))}
		</tr>
	);
}
