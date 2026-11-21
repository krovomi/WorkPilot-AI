import { Lock, Trophy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDate } from "../../lib/date-format";
import {
	ACHIEVEMENT_IDS,
	type AchievementId,
} from "../../lib/pixel-office-achievements";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ACHIEVEMENT_ICONS } from "./achievement-icons";

interface AchievementsPanelProps {
	/** When each earned achievement was first seen (ISO date). */
	readonly unlocked: Partial<Record<AchievementId, string>>;
}

/** The toolbar's trophy: how many are earned, and the whole list on click. */
export function AchievementsPanel({ unlocked }: AchievementsPanelProps) {
	const { t } = useTranslation(["pixelOffice"]);
	const earned = ACHIEVEMENT_IDS.filter((id) => unlocked[id]).length;
	const label = t("pixelOffice:achievements.count", {
		earned,
		total: ACHIEVEMENT_IDS.length,
	});

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 px-2"
					aria-label={t("pixelOffice:achievements.open")}
				>
					<Trophy className="h-4 w-4" aria-hidden />
					<span className="text-xs font-mono">{label}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-3">
				<p className="mb-2 text-sm font-semibold">
					{t("pixelOffice:achievements.title")}
				</p>
				<ul className="flex flex-col gap-2">
					{ACHIEVEMENT_IDS.map((id) => (
						<AchievementRow key={id} id={id} at={unlocked[id]} />
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

function AchievementRow({
	id,
	at,
}: {
	readonly id: AchievementId;
	readonly at: string | undefined;
}) {
	const { t } = useTranslation(["pixelOffice"]);
	const Icon = at ? ACHIEVEMENT_ICONS[id] : Lock;
	return (
		<li
			data-testid={`achievement-${id}`}
			data-earned={at ? "true" : "false"}
			className={`flex items-start gap-2 ${at ? "" : "opacity-50"}`}
		>
			<Icon
				className={`mt-0.5 h-4 w-4 shrink-0 ${at ? "text-warning" : "text-muted-foreground"}`}
				aria-hidden
			/>
			<span className="flex min-w-0 flex-col">
				<span className="text-sm font-medium">
					{t(`pixelOffice:achievements.items.${id}.name`)}
				</span>
				<span className="text-xs text-muted-foreground">
					{t(`pixelOffice:achievements.items.${id}.description`)}
				</span>
				<span className="text-3xs text-muted-foreground">
					{at
						? t("pixelOffice:achievements.earnedOn", { date: formatAppDate(at) })
						: t("pixelOffice:achievements.locked")}
				</span>
			</span>
		</li>
	);
}
