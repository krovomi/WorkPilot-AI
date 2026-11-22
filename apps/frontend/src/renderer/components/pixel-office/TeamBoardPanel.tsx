import {
	HeartHandshake,
	type LucideIcon,
	Mountain,
	PackageCheck,
	Rocket,
	Users,
	UsersRound,
} from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	TeamBadgeId,
	TeamBoardPeriod,
	TeamBoardScope,
} from "../../../shared/types/pixel-office";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { useTeamBoard } from "./use-team-board";

export const TEAM_BADGE_ICONS: Record<TeamBadgeId, LucideIcon> = {
	first_delivery: PackageCheck,
	ten_deliveries: Rocket,
	complex_delivery: Mountain,
	first_review: HeartHandshake,
	ten_reviews: Users,
};

interface TeamBoardPanelProps {
	/** A server project: the board is computed by the team's server. */
	readonly projectId: string;
}

/**
 * The toolbar's team leaderboard, for a server project: the people who
 * agreed to show by name, and the person's own score and badges, which only
 * they see unless they say yes.
 */
export function TeamBoardPanel({ projectId }: TeamBoardPanelProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const [open, setOpen] = useState(false);
	const team = useTeamBoard(projectId, open);
	const switchId = useId();
	const board = team.board;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 px-2"
					aria-label={t("pixelOffice:team.open")}
				>
					<UsersRound className="h-4 w-4" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-96 p-3" data-testid="team-board">
				<p className="text-sm font-semibold">{t("pixelOffice:team.title")}</p>
				<div className="mt-2 flex flex-wrap gap-2">
					<Choice<TeamBoardScope>
						label={t("pixelOffice:team.scopeLabel")}
						value={team.scope}
						options={["project", "org"]}
						onChange={team.setScope}
						text={(v) => t(`pixelOffice:team.scope.${v}`)}
					/>
					<Choice<TeamBoardPeriod>
						label={t("pixelOffice:team.periodLabel")}
						value={team.period}
						options={["season", "all"]}
						onChange={team.setPeriod}
						text={(v) => t(`pixelOffice:team.period.${v}`)}
					/>
				</div>

				{team.error && (
					<p role="alert" className="mt-3 text-xs text-destructive">
						{t("pixelOffice:team.error")}
					</p>
				)}
				{!board && team.loading && (
					<p className="mt-3 text-xs text-muted-foreground">{t("pixelOffice:team.loading")}</p>
				)}

				{board && (
					<>
						{board.entries.length === 0 ? (
							<p className="mt-3 text-xs text-muted-foreground" data-testid="team-board-empty">
								{t("pixelOffice:team.empty")}
							</p>
						) : (
							<ol className="mt-3 flex flex-col gap-1.5" aria-busy={team.loading}>
								{board.entries.map((entry) => (
									<li
										key={`${entry.rank}-${entry.name}`}
										data-testid="team-board-entry"
										className={cn(
											"flex items-center gap-2 rounded px-1.5 py-1 text-sm",
											entry.you && "bg-accent",
										)}
									>
										<span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
											{t("pixelOffice:team.rank", { rank: entry.rank })}
										</span>
										<span className="min-w-0 flex-1 truncate font-medium">
											{entry.you ? t("pixelOffice:team.you", { name: entry.name }) : entry.name}
										</span>
										<Badges ids={entry.badges} />
										<span className="font-mono text-xs">
											{t("pixelOffice:team.points", { count: entry.points })}
										</span>
									</li>
								))}
							</ol>
						)}

						<div className="mt-3 border-t pt-3" data-testid="team-board-me">
							<p className="text-xs font-semibold">{t("pixelOffice:team.mine")}</p>
							<p className="text-xs text-muted-foreground">
								{t("pixelOffice:team.mySummary", {
									points: board.me.points,
									delivered: board.me.delivered,
									reviews: board.me.reviews,
								})}
							</p>
							{board.me.badges.length > 0 ? (
								<ul className="mt-1 flex flex-col gap-0.5">
									{board.me.badges.map((id) => {
										const Icon = TEAM_BADGE_ICONS[id];
										return (
											<li key={id} className="flex items-center gap-1.5 text-xs">
												<Icon className="h-3.5 w-3.5 text-warning" aria-hidden />
												{t(`pixelOffice:team.badges.${id}`)}
											</li>
										);
									})}
								</ul>
							) : (
								<p className="mt-1 text-xs text-muted-foreground">
									{t("pixelOffice:team.noBadges")}
								</p>
							)}
							<div className="mt-2 flex items-center justify-between gap-2">
								<label htmlFor={switchId} className="text-xs">
									{t("pixelOffice:team.showMe")}
								</label>
								<Switch
									id={switchId}
									checked={board.me.visible}
									disabled={team.saving}
									onCheckedChange={(checked) => void team.setVisible(checked)}
								/>
							</div>
							<p className="text-3xs text-muted-foreground">
								{board.me.visible
									? t("pixelOffice:team.shown")
									: t("pixelOffice:team.hidden")}
							</p>
						</div>
						<p className="mt-2 text-3xs text-muted-foreground">{t("pixelOffice:team.howItCounts")}</p>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

function Badges({ ids }: { readonly ids: readonly TeamBadgeId[] }) {
	const { t } = useTranslation(["pixelOffice"]);
	return (
		<span className="flex shrink-0 gap-0.5">
			{ids.map((id) => {
				const Icon = TEAM_BADGE_ICONS[id];
				return (
					<Icon
						key={id}
						className="h-3.5 w-3.5 text-warning"
						role="img"
						aria-label={t(`pixelOffice:team.badges.${id}`)}
					/>
				);
			})}
		</span>
	);
}

function Choice<T extends string>({
	label,
	value,
	options,
	onChange,
	text,
}: {
	readonly label: string;
	readonly value: T;
	readonly options: readonly T[];
	readonly onChange: (value: T) => void;
	readonly text: (value: T) => string;
}) {
	return (
		<fieldset className="flex gap-1">
			<legend className="sr-only">{label}</legend>
			{options.map((option) => (
				<Button
					key={option}
					type="button"
					variant={option === value ? "secondary" : "ghost"}
					size="sm"
					className="h-7 px-2 text-xs"
					aria-pressed={option === value}
					onClick={() => onChange(option)}
				>
					{text(option)}
				</Button>
			))}
		</fieldset>
	);
}
