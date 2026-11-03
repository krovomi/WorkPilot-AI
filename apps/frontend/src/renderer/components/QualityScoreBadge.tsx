/**
 * Quality Score Badge Component
 * Displays the code quality grade with a color-coded badge
 */

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useTranslation } from "react-i18next";

interface QualityScoreBadgeProps {
	score: number; // 0-100
	grade: string; // A+, A, B, C, D, F
	isPassing: boolean;
	className?: string;
	showTooltip?: boolean;
}

// Color mapping for grades
const GRADE_COLORS: Record<string, string> = {
	"A+": "bg-success hover:bg-success/90 text-success-foreground",
	A: "bg-success hover:bg-success/90 text-success-foreground",
	"A-": "bg-success hover:bg-success/90 text-success-foreground",
	"B+": "bg-lime-500 hover:bg-lime-600 text-white",
	B: "bg-warning hover:bg-warning/90 text-warning-foreground",
	"B-": "bg-warning hover:bg-warning/90 text-warning-foreground",
	"C+": "bg-orange-400 hover:bg-orange-500 text-white",
	C: "bg-orange-500 hover:bg-orange-600 text-white",
	"C-": "bg-orange-600 hover:bg-orange-700 text-white",
	D: "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
	F: "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
};

// Emoji for grades
const GRADE_EMOJI: Record<string, string> = {
	"A+": "🏆",
	A: "⭐",
	"A-": "✨",
	"B+": "👍",
	B: "👌",
	"B-": "🙂",
	"C+": "😐",
	C: "😕",
	"C-": "😟",
	D: "⚠️",
	F: "❌",
};

export function QualityScoreBadge({
	score,
	grade,
	isPassing,
	className,
	showTooltip = true,
}: QualityScoreBadgeProps) {
	const { t } = useTranslation();
	const colorClass =
		GRADE_COLORS[grade] || "bg-gray-500 hover:bg-gray-600 text-white";
	const emoji = GRADE_EMOJI[grade] || "📊";

	const badge = (
		<Badge
			className={cn(
				"font-mono font-bold text-sm px-3 py-1",
				colorClass,
				className,
			)}
		>
			{emoji} {grade}
		</Badge>
	);

	if (!showTooltip) {
		return badge;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{badge}</TooltipTrigger>
			<TooltipContent>
				<div className="text-sm">
					<div className="font-semibold mb-1">{t("common:qualityScore.title")}</div>
					<div>
						{t("common:qualityScore.scoreLine", {
								score: score.toFixed(1),
								grade,
							})}
					</div>
					<div className="text-xs text-muted-foreground mt-1">
						{isPassing
								? t("common:qualityScore.passing")
								: t("common:qualityScore.failed")}
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
