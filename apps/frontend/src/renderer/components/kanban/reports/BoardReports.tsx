/**
 * The Kanban's « Rapports » (Jira's agile reports): the active sprint's
 * burndown, the velocity of the closed sprints, the cumulative flow, the
 * cycle time, the weekly throughput and the ends that were not a success.
 * Read from the project's cards and sprints, whatever the board's filters;
 * the figures come from `lib/kanban-reports.ts`.
 *
 * Design: docs/architecture/kanban-reports.md.
 */
import { BarChart3 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../../shared/types";
import { activeSprint, velocity } from "../../../../shared/utils/sprints";
import {
	burndown,
	CYCLE_BINS,
	cumulativeFlow,
	cycleTime,
	FLOW_BANDS,
	type FlowBand,
	notOkEnds,
	type ReasonCount,
	throughput,
	velocityBars,
} from "../../../lib/kanban-reports";
import { useSprintStore } from "../../../stores/sprint-store";
import { useTaskStore } from "../../../stores/task-store";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { BarChart, FigureTable, LineChart, shortDay, StackedChart, type Tone } from "./ReportCharts";

const REPORTS = ["burndown", "velocity", "flow", "cycle", "throughput", "ends"] as const;
type Report = (typeof REPORTS)[number];

const BAND_TONES: Record<FlowBand, Tone> = { todo: "muted", doing: "warning", review: "info", done: "success" };

function Empty({ children }: { children: ReactNode }) {
	return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function Summary({ children }: { children: ReactNode }) {
	return <p className="text-sm text-foreground">{children}</p>;
}

function BurndownReport({ tasks, now }: { tasks: Task[]; now: number }) {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const sprint = activeSprint(sprints);
	const data = sprint ? burndown(sprint, tasks, now) : null;
	if (!sprint || !data) return <Empty>{t("tasks:kanban.reports.burndown.empty")}</Empty>;
	const left = [...data.remaining].reverse().find((value) => value !== null) ?? data.scope;
	const labels = data.days.map(shortDay);
	const title = t("tasks:kanban.reports.burndown.chart", { name: sprint.name });
	return (
		<div className="space-y-3">
			<Summary>{t("tasks:kanban.reports.burndown.summary", { name: sprint.name, left, scope: data.scope })}</Summary>
			<LineChart
				title={title}
				labels={labels}
				series={[
					{ key: "ideal", label: t("tasks:kanban.reports.burndown.ideal"), tone: "muted", values: data.ideal, dashed: true },
					{ key: "remaining", label: t("tasks:kanban.reports.burndown.remaining"), tone: "primary", values: data.remaining },
				]}
			/>
			<FigureTable
				caption={title}
				head={[t("tasks:kanban.reports.day"), t("tasks:kanban.reports.burndown.ideal"), t("tasks:kanban.reports.burndown.remaining")]}
				rows={labels.map((label, index) => [label, data.ideal[index], data.remaining[index] ?? "—"])}
			/>
		</div>
	);
}

function VelocityReport() {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const bars = velocityBars(sprints);
	if (bars.length === 0) return <Empty>{t("tasks:kanban.reports.velocity.empty")}</Empty>;
	const title = t("tasks:kanban.reports.velocity.chart");
	const series = [
		{ key: "committed", label: t("tasks:kanban.reports.velocity.committed"), tone: "muted" as Tone },
		{ key: "done", label: t("tasks:kanban.reports.velocity.done"), tone: "primary" as Tone },
	];
	return (
		<div className="space-y-3">
			<Summary>{t("tasks:kanban.reports.velocity.summary", { points: velocity(sprints) })}</Summary>
			<BarChart
				title={title}
				series={series}
				groups={bars.map((bar) => ({ key: bar.id, label: bar.name, values: [bar.committed, bar.done] }))}
			/>
			<FigureTable
				caption={title}
				head={[t("tasks:kanban.reports.sprint"), ...series.map((item) => item.label)]}
				rows={bars.map((bar) => [bar.name, bar.committed ?? "—", bar.done])}
			/>
		</div>
	);
}

function FlowReport({ tasks, now }: { tasks: Task[]; now: number }) {
	const { t } = useTranslation(["tasks"]);
	const flow = useMemo(() => cumulativeFlow(tasks, now), [tasks, now]);
	const labels = flow.days.map(shortDay);
	const title = t("tasks:kanban.reports.flow.chart");
	// Bottom band first: what is finished, then the work in review, in progress, to do.
	const bands = [...FLOW_BANDS].reverse();
	return (
		<div className="space-y-3">
			<Summary>{t("tasks:kanban.reports.flow.summary")}</Summary>
			<StackedChart
				title={title}
				labels={labels}
				series={bands.map((band) => ({
					key: band,
					label: t(`tasks:kanban.reports.flow.bands.${band}`),
					tone: BAND_TONES[band],
					values: flow.bands[band],
				}))}
			/>
			<FigureTable
				caption={title}
				head={[t("tasks:kanban.reports.day"), ...FLOW_BANDS.map((band) => t(`tasks:kanban.reports.flow.bands.${band}`))]}
				rows={labels.map((label, index) => [label, ...FLOW_BANDS.map((band) => flow.bands[band][index])])}
			/>
		</div>
	);
}

function CycleReport({ tasks, now }: { tasks: Task[]; now: number }) {
	const { t } = useTranslation(["tasks"]);
	const cycle = useMemo(() => cycleTime(tasks, now), [tasks, now]);
	if (cycle.count === 0) return <Empty>{t("tasks:kanban.reports.cycle.empty")}</Empty>;
	const title = t("tasks:kanban.reports.cycle.chart");
	const label = (bin: string) => t(`tasks:kanban.reports.cycle.bins.${bin}`);
	return (
		<div className="space-y-3">
			<Summary>
				{t("tasks:kanban.reports.cycle.summary", { count: cycle.count, median: cycle.median, p85: cycle.p85 })}
			</Summary>
			<BarChart
				title={title}
				series={[{ key: "cards", label: t("tasks:kanban.reports.cards"), tone: "primary" }]}
				groups={CYCLE_BINS.map((bin) => ({ key: bin, label: label(bin), values: [cycle.bins[bin]] }))}
			/>
			<FigureTable
				caption={title}
				head={[t("tasks:kanban.reports.cycle.span"), t("tasks:kanban.reports.cards")]}
				rows={CYCLE_BINS.map((bin) => [label(bin), cycle.bins[bin]])}
			/>
		</div>
	);
}

function ThroughputReport({ tasks, now }: { tasks: Task[]; now: number }) {
	const { t } = useTranslation(["tasks"]);
	const weeks = useMemo(() => throughput(tasks, now), [tasks, now]);
	const total = weeks.reduce((sum, week) => sum + week.count, 0);
	const title = t("tasks:kanban.reports.throughput.chart");
	return (
		<div className="space-y-3">
			<Summary>{t("tasks:kanban.reports.throughput.summary", { count: total, weeks: weeks.length })}</Summary>
			<BarChart
				title={title}
				series={[{ key: "cards", label: t("tasks:kanban.reports.cards"), tone: "success" }]}
				groups={weeks.map((week) => ({ key: week.week, label: shortDay(week.week), values: [week.count] }))}
			/>
			<FigureTable
				caption={title}
				head={[t("tasks:kanban.reports.throughput.week"), t("tasks:kanban.reports.cards")]}
				rows={weeks.map((week) => [shortDay(week.week), week.count])}
			/>
		</div>
	);
}

function ReasonList({ title, items, labelOf }: { title: string; items: ReasonCount[]; labelOf: (reason: string) => string }) {
	return (
		<section className="space-y-1.5">
			<h4 className="text-sm font-semibold">{title}</h4>
			<ul className="space-y-1">
				{items.map((item) => (
					<li key={item.reason} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 text-sm">
						<span>{labelOf(item.reason)}</span>
						<span className="tabular-nums text-muted-foreground">{item.count}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function EndsReport({ tasks }: { tasks: Task[] }) {
	const { t } = useTranslation(["tasks"]);
	const ends = useMemo(() => notOkEnds(tasks), [tasks]);
	if (ends.abandoned.length === 0 && ends.failed.length === 0) {
		return <Empty>{t("tasks:kanban.reports.ends.empty")}</Empty>;
	}
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{ends.failed.length > 0 && (
				<ReasonList
					title={t("tasks:kanban.reports.ends.failed")}
					items={ends.failed}
					labelOf={(reason) => t(`tasks:kanban.reports.ends.reasons.${reason}`, { defaultValue: reason })}
				/>
			)}
			{ends.abandoned.length > 0 && (
				<ReasonList
					title={t("tasks:kanban.reports.ends.abandoned")}
					items={ends.abandoned}
					labelOf={(reason) => t(`tasks:abandon.resolutions.${reason}`, { defaultValue: reason })}
				/>
			)}
		</div>
	);
}

function BoardReportsDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
	const { t } = useTranslation(["tasks"]);
	const tasks = useTaskStore((s) => s.tasks);
	const [now] = useState(() => Date.now());
	const [report, setReport] = useState<Report>("burndown");
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("tasks:kanban.reports.title")}</DialogTitle>
					<DialogDescription>{t("tasks:kanban.reports.description")}</DialogDescription>
				</DialogHeader>
				<Tabs value={report} onValueChange={(value) => setReport(value as Report)}>
					<TabsList className="flex-wrap">
						{REPORTS.map((item) => (
							<TabsTrigger key={item} value={item}>
								{t(`tasks:kanban.reports.tabs.${item}`)}
							</TabsTrigger>
						))}
					</TabsList>
					<TabsContent value="burndown">
						<BurndownReport tasks={tasks} now={now} />
					</TabsContent>
					<TabsContent value="velocity">
						<VelocityReport />
					</TabsContent>
					<TabsContent value="flow">
						<FlowReport tasks={tasks} now={now} />
					</TabsContent>
					<TabsContent value="cycle">
						<CycleReport tasks={tasks} now={now} />
					</TabsContent>
					<TabsContent value="throughput">
						<ThroughputReport tasks={tasks} now={now} />
					</TabsContent>
					<TabsContent value="ends">
						<EndsReport tasks={tasks} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

/** The toolbar's « Rapports » button and its dialog. */
export function BoardReportsButton() {
	const { t } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="h-8 gap-2 rounded-full text-muted-foreground hover:text-foreground"
				onClick={() => setOpen(true)}
			>
				<BarChart3 className="h-4 w-4" aria-hidden="true" />
				{t("tasks:kanban.reports.button")}
			</Button>
			{open && <BoardReportsDialog onOpenChange={setOpen} />}
		</>
	);
}
