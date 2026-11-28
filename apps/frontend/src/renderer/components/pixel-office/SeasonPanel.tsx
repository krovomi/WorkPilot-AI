import { CalendarRange, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDate } from "../../lib/date-format";
import {
	DECOR_IDS,
	type DecorId,
	type GoalProgress,
	type Season,
} from "../../lib/pixel-office-seasons";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Progress } from "../ui/progress";

interface SeasonPanelProps {
	readonly season: Season;
	readonly progress: readonly GoalProgress[];
	/** The decor earned so far, with the season that earned it. */
	readonly decor: Partial<Record<DecorId, string>>;
}

/** The toolbar's season: its goals this quarter, and the decor they earn. */
export function SeasonPanel({ season, progress, decor }: SeasonPanelProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const met = progress.filter((p) => p.done).length;
	const name = t("pixelOffice:seasons.name", {
		quarter: season.quarter,
		year: season.year,
	});
	const lastDay = new Date(season.end.getTime() - 1);
	const earned = DECOR_IDS.filter((id) => decor[id]);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 px-2"
					aria-label={t("pixelOffice:seasons.open", { name })}
				>
					<CalendarRange className="h-4 w-4" aria-hidden />
					<span className="text-xs font-mono">
						{t("pixelOffice:seasons.count", { met, total: progress.length })}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-3">
				<p className="text-sm font-semibold">{name}</p>
				<p className="mb-3 text-xs text-muted-foreground">
					{t("pixelOffice:seasons.ends", { date: formatAppDate(lastDay) })}
				</p>
				<ul className="flex flex-col gap-3">
					{progress.map((p) => (
						<li
							key={p.goal.id}
							data-testid={`season-goal-${p.goal.id}`}
							data-done={p.done ? "true" : "false"}
							className="flex flex-col gap-1"
						>
							<span className="flex items-center justify-between gap-2 text-sm">
								<span className="flex items-center gap-1 font-medium">
									{p.done && <Check className="h-3.5 w-3.5 text-success" aria-hidden />}
									{t(`pixelOffice:seasons.goals.${p.goal.id}`, { count: p.goal.target })}
								</span>
								<span className="text-xs font-mono text-muted-foreground">
									{t("pixelOffice:seasons.progress", {
										count: Math.min(p.count, p.goal.target),
										target: p.goal.target,
									})}
								</span>
							</span>
							<Progress value={Math.min(100, (p.count / p.goal.target) * 100)} />
							<span className="text-3xs text-muted-foreground">
								{t("pixelOffice:seasons.reward", {
									decor: t(`pixelOffice:seasons.decor.${p.goal.reward}`),
								})}
							</span>
						</li>
					))}
				</ul>
				<p className="mt-3 text-xs text-muted-foreground" data-testid="season-decor">
					{earned.length > 0
						? t("pixelOffice:seasons.earned", {
								list: earned
									.map((id) => t(`pixelOffice:seasons.decor.${id}`))
									.join(", "),
							})
						: t("pixelOffice:seasons.noDecor")}
				</p>
			</PopoverContent>
		</Popover>
	);
}
