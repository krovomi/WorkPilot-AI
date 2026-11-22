/**
 * How replays are shared (#347), shown above the list of recordings: the
 * exports of this machine week by week and the share of its sessions that
 * carry a bookmark, and, on a server project, what the team does with its
 * links. The first is counted on this machine, the second by the person's
 * own server for the project; neither is sent anywhere else, and the view
 * says so.
 */

import { BarChart3 } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { TFunction } from "i18next";
import { appDateLocale, formatAppDate } from "@/lib/date-format";
import type { ReplayTeamUsage, ReplayUsage } from "../../../shared/types/replay-share";
import { useProjectStore } from "../../stores/project-store";
import { useReplayUsageStore } from "../../stores/replay-usage-store";
import { Bar, Notice, Section, Stat, Stats } from "../charter";

const percent = (t: TFunction, ratio: number | null): string =>
	ratio === null
		? t("replay:usage.none")
		: t("replay:usage.percent", { value: Math.round(ratio * 100) });

/** A decimal in the app's language (0.38 / 0,38). */
const decimal = (value: number): string =>
	new Intl.NumberFormat(appDateLocale(), { maximumFractionDigits: 2 }).format(value);

/** One bar per week, scaled to the busiest week. */
const WeekBars: React.FC<{
	weeks: { start: string; value: number }[];
	labelKey: string;
}> = ({ weeks, labelKey }) => {
	const { t } = useTranslation(["replay"]);
	const top = Math.max(1, ...weeks.map((week) => week.value));
	return (
		<ul className="mt-3 space-y-1">
			{weeks.map((week) => (
				<li key={week.start} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-xs">
					<span className="wp-meta">
						{t("replay:usage.weekOf", { date: formatAppDate(week.start) })}
					</span>
					<Bar value={(week.value / top) * 100} tone="violet" />
					<span className="text-right tabular-nums" title={t(labelKey, { count: week.value })}>
						{week.value}
					</span>
				</li>
			))}
		</ul>
	);
};

const LocalFigures: React.FC<{ usage: ReplayUsage }> = ({ usage }) => {
	const { t } = useTranslation(["replay"]);
	return (
		<div>
			<Stats>
				<Stat label={t("replay:usage.local.perWeek")} value={decimal(usage.exportsPerWeek)} />
				<Stat
					label={t("replay:usage.local.exports", { weeks: usage.weeks.length })}
					value={usage.exports}
				/>
				<Stat
					label={t("replay:usage.local.annotated")}
					value={percent(t, usage.annotatedRatio)}
					tone="violet"
				/>
				<Stat label={t("replay:usage.local.discussed")} value={usage.sessions.discussed} />
				<Stat label={t("replay:usage.local.summarized")} value={usage.sessions.summarized} />
				<Stat label={t("replay:usage.local.imported")} value={usage.sessions.imported} />
			</Stats>
			<WeekBars
				labelKey="replay:usage.local.weekCount"
				weeks={usage.weeks.map((week) => ({ start: week.start, value: week.total }))}
			/>
			<p className="wp-meta mt-2">{t("replay:usage.local.where")}</p>
		</div>
	);
};

const TeamFigures: React.FC<{ usage: ReplayTeamUsage; project: string }> = ({
	usage,
	project,
}) => {
	const { t } = useTranslation(["replay"]);
	return (
		<div className="mt-4 border-t border-[var(--wp-border)] pt-3">
			<h3 className="wp-title text-sm">{t("replay:usage.team.title", { project })}</h3>
			<Stats>
				<Stat
					label={t("replay:usage.team.links", { days: usage.windowDays })}
					value={usage.links}
				/>
				<Stat label={t("replay:usage.team.openRate")} value={percent(t, usage.openRate)} tone="green" />
				<Stat label={t("replay:usage.team.opens")} value={usage.opens} />
				<Stat label={t("replay:usage.team.active")} value={usage.active} />
				<Stat label={t("replay:usage.team.annotated")} value={percent(t, usage.annotatedRatio)} />
				<Stat label={t("replay:usage.team.sharers")} value={usage.sharers} />
			</Stats>
			<WeekBars
				labelKey="replay:usage.team.weekCount"
				weeks={usage.weeks.map((week) => ({ start: week.start, value: week.created }))}
			/>
			<p className="wp-meta mt-2">{t("replay:usage.team.where")}</p>
		</div>
	);
};

export const ReplayUsageMetrics: React.FC = () => {
	const { t } = useTranslation(["replay"]);
	const project = useProjectStore((s) => {
		const found = s.projects.find((p) => p.id === s.selectedProjectId);
		return found?.remote ? found : null;
	});
	const projectId = project?.id ?? null;
	const { local, team, error, load } = useReplayUsageStore(
		useShallow((s) => ({ local: s.local, team: s.team, error: s.error, load: s.load })),
	);

	useEffect(() => {
		void load(projectId);
	}, [projectId, load]);

	const teamUsage = projectId ? team[projectId] : undefined;
	if (!local && !error) return null;

	return (
		<Section
			kicker={t("replay:usage.kicker")}
			title={t("replay:usage.title")}
			actions={<BarChart3 className="wp-muted h-4 w-4" aria-hidden="true" />}
		>
			{error && (
				<Notice tone="red" role="alert" className="mb-3">
					{t(error.key, error.values)}
				</Notice>
			)}
			{local && <LocalFigures usage={local} />}
			{project && teamUsage && <TeamFigures usage={teamUsage} project={project.name} />}
		</Section>
	);
};
