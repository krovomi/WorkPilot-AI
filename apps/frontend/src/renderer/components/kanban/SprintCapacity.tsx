/**
 * The capacity gauge of the sprint planning view: the points the sprint
 * holds against the points it can take (the velocity of the last sprints, or
 * the capacity the team set on it), with the last sprints' points done
 * beside it. The person adjusts the capacity when fewer people are around;
 * before any sprint closes it is a target, {@link DEFAULT_TARGET_POINTS}
 * until set. Points only, never a duration.
 *
 * `proposed` draws points that are offered but not in the sprint yet.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Sprint } from "../../../shared/types";
import { MAX_CAPACITY, sprintCapacity, velocityHistory } from "../../../shared/utils/sprints";
import { cn } from "../../lib/utils";
import { useSprintStore } from "../../stores/sprint-store";
import { useSprintFailure } from "./SprintDialogs";

interface SprintCapacityProps {
	sprint: Sprint;
	/** Points the sprint's cards add up to. */
	points: number;
	/** Points offered but not in the sprint yet. */
	proposed?: number;
	canEdit: boolean;
}

/** A tenth of the velocity, at least one point: one press of the stepper. */
function stepOf(velocity: number | null): number {
	return velocity ? Math.max(1, Math.round(velocity / 10)) : 1;
}

export function SprintCapacity({ sprint, points, proposed = 0, canEdit }: SprintCapacityProps) {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const save = useSprintStore((s) => s.save);
	const failed = useSprintFailure();
	const [busy, setBusy] = useState(false);
	const capacity = sprintCapacity(sprint, sprints);
	const history = velocityHistory(sprints);
	const total = points + proposed;
	const left = capacity.points - total;
	const scale = Math.max(capacity.points * 1.25, total, 1);
	const width = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;
	const tallest = Math.max(1, ...history.map((item) => item.report.donePoints));
	const step = stepOf(capacity.velocity);

	const change = async (next: number | null) => {
		if (busy) return;
		setBusy(true);
		const outcome = await save({
			id: sprint.id,
			name: sprint.name,
			goal: sprint.goal,
			startDate: sprint.startDate,
			endDate: sprint.endDate,
			capacity: next,
		});
		setBusy(false);
		failed(outcome);
	};
	const adjust = (delta: number) => {
		const next = Math.min(MAX_CAPACITY, Math.max(1, capacity.points + delta));
		// Back on the velocity, the sprint follows it again.
		void change(next === capacity.velocity ? null : next);
	};

	const verdict =
		left > 0
			? { tone: "room", text: t("tasks:kanban.sprints.capacity.room", { count: left }) }
			: left === 0
				? { tone: "full", text: t("tasks:kanban.sprints.capacity.full") }
				: { tone: "over", text: t("tasks:kanban.sprints.capacity.over", { count: -left }) };
	const share = capacity.velocity ? Math.round((capacity.points / capacity.velocity) * 100) : null;

	return (
		<section
			data-testid="sprint-capacity"
			aria-label={t("tasks:kanban.sprints.capacity.label")}
			className="grid gap-x-6 gap-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]"
		>
			<div className="min-w-0">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<span className="font-semibold tabular-nums">
						<span className="text-xl">{total}</span>
						<span className="ml-1 text-sm text-muted-foreground">
							{t("tasks:kanban.sprints.capacity.outOf", { count: capacity.points })}
						</span>
					</span>
					<span
						data-testid="sprint-capacity-verdict"
						className={cn(
							"rounded-full px-2 py-0.5 text-2xs font-semibold",
							verdict.tone === "room" && "bg-muted text-muted-foreground",
							verdict.tone === "full" && "bg-success/15 text-success",
							verdict.tone === "over" && "bg-warning/15 text-warning",
						)}
					>
						{verdict.text}
					</span>
					{canEdit && (
						<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
							{capacity.source === "default" || (capacity.source === "set" && !capacity.velocity)
								? t("tasks:kanban.sprints.capacity.target")
								: t("tasks:kanban.sprints.capacity.adjust")}
							<span className="inline-flex items-center rounded-md border border-border/60 bg-background">
								<button
									type="button"
									className="grid h-6 w-6 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
									onClick={() => adjust(-step)}
									disabled={busy || capacity.points <= 1}
									aria-label={t("tasks:kanban.sprints.capacity.less")}
								>
									<Minus className="h-3 w-3" />
								</button>
								<span className="min-w-[3.5rem] text-center font-semibold tabular-nums text-foreground">
									{share !== null
										? t("tasks:kanban.sprints.capacity.share", { percent: share })
										: t("tasks:kanban.sprints.planning.points", { count: capacity.points })}
								</span>
								<button
									type="button"
									className="grid h-6 w-6 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
									onClick={() => adjust(step)}
									disabled={busy || capacity.points >= MAX_CAPACITY}
									aria-label={t("tasks:kanban.sprints.capacity.more")}
								>
									<Plus className="h-3 w-3" />
								</button>
							</span>
							{capacity.source === "set" && capacity.velocity !== null && (
								<button
									type="button"
									className="inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
									onClick={() => void change(null)}
									disabled={busy}
								>
									<RotateCcw className="h-3 w-3" />
									{t("tasks:kanban.sprints.capacity.reset")}
								</button>
							)}
						</span>
					)}
				</div>
				<div
					className="relative mt-5 h-3 rounded-full bg-muted"
					role="img"
					aria-label={t("tasks:kanban.sprints.capacity.gauge", {
						points,
						proposed,
						capacity: capacity.points,
					})}
				>
					<div className="absolute inset-y-0 left-0 rounded-l-full bg-info" style={{ width: width(points) }} />
					{proposed > 0 && (
						<div
							data-testid="sprint-capacity-proposed"
							className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,currentColor_0_5px,transparent_5px_9px)] bg-violet-500/30 text-violet-500"
							style={{ left: width(points), width: width(proposed) }}
						/>
					)}
					<div
						className="absolute -inset-y-1.5 w-0.5 rounded bg-foreground"
						style={{ left: width(capacity.points) }}
						aria-hidden="true"
					>
						<span className="absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">
							{capacity.points}
						</span>
					</div>
				</div>
				<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
					<span className="inline-flex items-center gap-1.5">
						<span className="h-2 w-3 rounded-sm bg-info" aria-hidden="true" />
						{t("tasks:kanban.sprints.capacity.inSprint", { count: points })}
					</span>
					{proposed > 0 && (
						<span className="inline-flex items-center gap-1.5">
							<span className="h-2 w-3 rounded-sm bg-violet-500" aria-hidden="true" />
							{t("tasks:kanban.sprints.capacity.proposed", { count: proposed })}
						</span>
					)}
					<span className="inline-flex items-center gap-1.5" title={t("tasks:kanban.sprints.velocityHint")}>
						<span className="h-2.5 w-0.5 rounded bg-foreground" aria-hidden="true" />
						{capacity.source === "velocity"
							? t("tasks:kanban.sprints.capacity.lineVelocity")
							: capacity.source === "set"
								? t("tasks:kanban.sprints.capacity.lineSet")
								: t("tasks:kanban.sprints.capacity.lineTarget")}
					</span>
				</div>
			</div>
			{history.length > 0 ? (
				<ol className="flex items-end gap-2" aria-label={t("tasks:kanban.sprints.capacity.history")}>
					{history.map((item) => (
						<li key={item.id} className="grid justify-items-center gap-0.5" title={item.name}>
							<span className="text-2xs font-semibold tabular-nums">{item.report.donePoints}</span>
							<span
								className="block w-6 rounded-t bg-info/50"
								style={{ height: `${Math.max(0.2, (item.report.donePoints / tallest) * 2.25)}rem` }}
								aria-hidden="true"
							/>
							<span className="max-w-[3.5rem] truncate text-2xs text-muted-foreground">{item.name}</span>
						</li>
					))}
				</ol>
			) : (
				<p className="max-w-[18rem] self-center text-2xs text-muted-foreground">
					{t("tasks:kanban.sprints.capacity.noHistory", { points: capacity.points })}
				</p>
			)}
		</section>
	);
}
