/**
 * TaskPhaseProgressBar — the task's overall progress, coloured by phase.
 *
 * The filled length is the task's percentage (same number as before); it is
 * split into one segment per phase (planning yellow, coding blue, validation
 * violet) in proportion to the time each phase took, so a finished task shows
 * where its time went at a glance. A legend under the bar names each phase
 * with its share. See computePhaseSplit for the maths and the fallback when
 * the logs carry no timestamps.
 */
import { useTranslation } from "react-i18next";
import type { TaskLogPhase, TaskLogs } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { computePhaseSplit, type PhaseSegment } from "./phase-split";

const SEGMENT_CLASS: Record<TaskLogPhase, string> = {
	planning: "bg-phase-planning",
	coding: "bg-phase-coding",
	validation: "bg-phase-validation",
};

const PHASE_LABEL_KEYS: Record<TaskLogPhase, string> = {
	planning: "execution.phases.planning",
	coding: "execution.phases.coding",
	validation: "execution.phases.validation",
};

/** "45 s", "12 min", "1 h 05 min" in the app language. */
export function formatPhaseDuration(ms: number, language: string): string {
	const unit = (value: number, u: "second" | "minute" | "hour") =>
		new Intl.NumberFormat(language, {
			style: "unit",
			unit: u,
			unitDisplay: "short",
		}).format(value);
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return unit(totalSeconds, "second");
	const totalMinutes = Math.round(totalSeconds / 60);
	if (totalMinutes < 60) return unit(totalMinutes, "minute");
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0
		? unit(hours, "hour")
		: `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
}

interface TaskPhaseProgressBarProps {
	/** Overall task percentage (0-100), the number printed next to the bar. */
	progress: number;
	phaseLogs: TaskLogs | null | undefined;
	/** The task is executing: the running phase's segment shimmers. */
	isRunning?: boolean;
	/** Reference time for the running phase (tests); defaults to now. */
	now?: number;
	className?: string;
}

export function TaskPhaseProgressBar({
	progress,
	phaseLogs,
	isRunning = false,
	now,
	className,
}: TaskPhaseProgressBarProps) {
	const { t, i18n } = useTranslation("tasks");
	const split = computePhaseSplit(progress, phaseLogs, now);
	const language = i18n?.language ?? "en";
	const visible = split.segments.filter((s) => s.width > 0);

	const describe = (segment: PhaseSegment) => {
		const phase = t(PHASE_LABEL_KEYS[segment.phase]);
		return segment.durationMs !== null && split.basis === "time"
			? t("execution.split.segmentWithDuration", {
					phase,
					share: segment.share,
					duration: formatPhaseDuration(segment.durationMs, language),
				})
			: t("execution.split.segment", { phase, share: segment.share });
	};

	return (
		<div className={cn("min-w-0 space-y-1.5", className)}>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(progress)}
				aria-valuetext={visible.map(describe).join(", ") || undefined}
				className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-border"
				data-testid="task-phase-progress"
			>
				{visible.map((segment) => (
					<div
						key={segment.phase}
						data-phase={segment.phase}
						title={describe(segment)}
						className={cn(
							"h-full transition-[width] duration-500 ease-out last:rounded-r-full",
							SEGMENT_CLASS[segment.phase],
							isRunning && segment.active && "phase-segment-active",
						)}
						style={{ width: `${segment.width}%` }}
					/>
				))}
			</div>
			{visible.length > 0 && (
				<ul
					className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground"
					aria-label={t("execution.split.legend")}
				>
					{visible.map((segment) => (
						<li
							key={segment.phase}
							className="flex items-center gap-1"
							title={describe(segment)}
						>
							<span
								aria-hidden="true"
								className={cn(
									"h-2 w-2 shrink-0 rounded-full",
									SEGMENT_CLASS[segment.phase],
								)}
							/>
							<span>{t(PHASE_LABEL_KEYS[segment.phase])}</span>
							<span className="font-medium tabular-nums text-foreground">
								{t("execution.split.share", { share: segment.share })}
							</span>
							{segment.durationMs !== null && split.basis === "time" && (
								<span className="tabular-nums">
									({formatPhaseDuration(segment.durationMs, language)})
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
