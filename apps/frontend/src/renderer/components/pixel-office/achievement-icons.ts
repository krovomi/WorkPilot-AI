import {
	BadgeCheck,
	Bot,
	Flame,
	LifeBuoy,
	type LucideIcon,
	Rocket,
	Sparkles,
	Users,
} from "lucide-react";
import type { AchievementId } from "../../lib/pixel-office-achievements";

export const ACHIEVEMENT_ICONS: Record<AchievementId, LucideIcon> = {
	"first-ship": Rocket,
	"ten-ships-week": Flame,
	"qa-first-try": BadgeCheck,
	"qa-first-try-five": Sparkles,
	"incident-resolved": LifeBuoy,
	"incident-fixed-by-agent": Bot,
	"second-opinion": Users,
};
