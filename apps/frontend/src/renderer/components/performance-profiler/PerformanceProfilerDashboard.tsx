/**
 * Profileur de performance, in the UI charter (docs/architecture/ui-charter.md):
 * the run and its summary on the left, the bottlenecks in the middle, the
 * optimizations on the right, the analyse action in the composer.
 */
import { Activity, Gauge as GaugeIcon, Lightbulb, Play, X, Zap } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
	cancelPerformanceProfiling,
	type PerformanceProfilerPhase,
	startPerformanceProfiling,
	usePerformanceProfilerStore,
} from "../../stores/performance-profiler-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	StepCard,
	type Tone,
} from "../charter";

const SEVERITY_TONE: Record<string, Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
};

export function PerformanceProfilerDashboard(): React.ReactElement {
	const { t } = useTranslation(["performanceProfiler", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const {
		phase,
		status,
		streamingOutput,
		result,
		implementationResult,
		error,
		autoImplement,
		setAutoImplement,
	} = usePerformanceProfilerStore();

	const isRunning = ["profiling", "analyzing", "optimizing"].includes(phase);
	const phaseLabel = (p: PerformanceProfilerPhase) =>
		t(`performanceProfiler:phases.${p}`);
	const isComplete = phase === "complete";

	function handleStart() {
		if (!activeProject?.path) return;
		startPerformanceProfiling(activeProject.path);
	}

	const criticalCount =
		result?.report?.bottlenecks.filter((b) => b.severity === "critical")
			.length ?? 0;
	const highCount =
		result?.report?.bottlenecks.filter((b) => b.severity === "high").length ??
		0;

	const report = isComplete ? result?.report : undefined;
	const bottlenecks = report?.bottlenecks ?? [];
	const suggestions = report?.suggestions ?? [];
	const benchmarks = report?.benchmarks ?? [];

	return (
		<ModuleStage data-testid="performance-profiler-view">
			<ModuleHeader
				kicker={t("navigation:groups.development")}
				title={t("performanceProfiler:title")}
				description={t("performanceProfiler:subtitle")}
				icon={Activity}
			/>
			<Columns template="minmax(240px, 24%) minmax(0, 1fr) minmax(0, 1fr)">
				<Column
					kicker={t("performanceProfiler:kickers.run")}
					title={phaseLabel(phase)}
					tone="blue"
				>
					<div className="flex flex-col gap-3">
						{isRunning && <ScanLine label={status && status !== phaseLabel(phase) ? status : phaseLabel(phase)} />}
						{report?.summary ? (
							<Stats>
								<Stat label={t("performanceProfiler:summary.bottlenecks")} value={report.summary.total_bottlenecks} />
								<Stat label={t("performanceProfiler:summary.critical")} value={criticalCount} tone={criticalCount ? "red" : "green"} />
								<Stat label={t("performanceProfiler:summary.highPriority")} value={highCount} tone={highCount ? "orange" : "green"} />
								<Stat label={t("performanceProfiler:summary.optimizations")} value={report.summary.total_suggestions} tone="green" />
							</Stats>
						) : (
							!isRunning && (
								<EmptyStage icon={Zap} title={t("performanceProfiler:empty.title")} tone="blue">
									{t("performanceProfiler:empty.body")}
								</EmptyStage>
							)
						)}
						{benchmarks.length > 0 && (
							<Panel>
								<span className="wp-kicker">{t("performanceProfiler:results.benchmarks")}</span>
								<ul className="mt-2 flex flex-col gap-1">
									{benchmarks.map((b, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: list is static and never reordered
										<li key={i} className="flex justify-between gap-2 text-xs">
											<span className="truncate">{b.name}</span>
											<span className="wp-meta">
												{b.duration_ms != null
													? `${b.duration_ms.toFixed(1)}ms`
													: t("performanceProfiler:results.notAvailable")}
											</span>
										</li>
									))}
								</ul>
							</Panel>
						)}
						{(isRunning || (!isComplete && streamingOutput)) && streamingOutput && (
							<pre className="wp-code max-h-72 overflow-auto">{streamingOutput}</pre>
						)}
					</div>
				</Column>

				<Column
					kicker={t("performanceProfiler:kickers.bottlenecks")}
					title={t("performanceProfiler:results.bottlenecks", { count: bottlenecks.length })}
					tone="red"
				>
					{isComplete && bottlenecks.length === 0 && (
						<Notice tone="green" icon={GaugeIcon}>
							{t("performanceProfiler:results.noBottlenecks")}
						</Notice>
					)}
					{!isComplete && (
						<EmptyStage icon={GaugeIcon} title={t("performanceProfiler:kickers.bottlenecks")} tone="red">
							{t("performanceProfiler:empty.body")}
						</EmptyStage>
					)}
					<div className="flex flex-col gap-2">
						{bottlenecks.map((b, i) => (
							<StepCard
								// biome-ignore lint/suspicious/noArrayIndexKey: no stable key available
								key={i}
								tone={SEVERITY_TONE[b.severity] ?? "muted"}
								kicker={b.type.replace(/_/g, " ")}
								title={b.description}
								meta={b.file_path ? `${b.file_path}${b.line_start ? `:${b.line_start}` : ""}` : undefined}
								status={
									<Chip tone={SEVERITY_TONE[b.severity] ?? "muted"}>
										{t(`performanceProfiler:severity.${b.severity}`, b.severity)}
									</Chip>
								}
							/>
						))}
					</div>
				</Column>

				<Column
					kicker={t("performanceProfiler:kickers.fixes")}
					title={t("performanceProfiler:results.optimizations", { count: suggestions.length })}
					tone="green"
				>
					<div className="flex flex-col gap-2">
						{Boolean(implementationResult) && (
							<Notice tone="green">{t("performanceProfiler:results.autoImplemented")}</Notice>
						)}
						{suggestions.length === 0 && (
							<EmptyStage icon={Lightbulb} title={t("performanceProfiler:kickers.fixes")} tone="green">
								{t("performanceProfiler:emptyFixes")}
							</EmptyStage>
						)}
						{suggestions.map((s, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: list is static and never reordered
							<Panel key={i} rail tone="green">
								<div className="mb-1 flex items-start justify-between gap-2">
									<span className="text-sm font-semibold">{s.title}</span>
									<span className="wp-meta">{t(`performanceProfiler:effort.${s.effort}`, s.effort)}</span>
								</div>
								<p className="wp-muted text-xs">{s.description}</p>
								{s.estimated_improvement && (
									<p className="mt-1 text-xs text-success">↑ {s.estimated_improvement}</p>
								)}
								{s.implementation && (
									<details className="mt-2">
										<summary className="cursor-pointer text-xs text-primary">
											{t("performanceProfiler:results.viewImplementation")}
										</summary>
										<pre className="wp-code mt-1">{s.implementation}</pre>
									</details>
								)}
							</Panel>
						))}
					</div>
				</Column>
			</Columns>

			{error && (
				<Notice tone="red" role="alert" className="relative z-[2] mx-5 mb-2">
					{error}
				</Notice>
			)}
			<Composer
				prompt={<span className="wp-muted truncate text-xs">{activeProject?.path ?? "—"}</span>}
				options={
					<label className="wp-field cursor-pointer" title={t("performanceProfiler:options.autoImplementHint")}>
						<input
							type="checkbox"
							checked={autoImplement}
							onChange={(e) => setAutoImplement(e.target.checked)}
							disabled={isRunning}
							className="accent-[var(--wp-accent)]"
						/>
						<b>{t("performanceProfiler:options.autoImplement")}</b>
						{t("performanceProfiler:options.autoImplementHint")}
					</label>
				}
				actions={
					isRunning ? (
						<CharterButton variant="danger" icon={X} onClick={cancelPerformanceProfiling}>
							{t("performanceProfiler:actions.cancel")}
						</CharterButton>
					) : (
						<CharterButton variant="primary" icon={Play} onClick={handleStart} disabled={!activeProject}>
							{isComplete ? t("performanceProfiler:actions.reanalyze") : t("performanceProfiler:actions.analyze")}
						</CharterButton>
					)
				}
			/>
		</ModuleStage>
	);
}

export default PerformanceProfilerDashboard;
