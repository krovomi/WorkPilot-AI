import {
	BookOpen,
	Code2,
	Gauge,
	Lightbulb,
	type LucideIcon,
	Palette,
	Shield,
	Zap,
} from "lucide-react";
import type { IdeationType } from "../../../shared/types";

/** The glyph of each ideation type (tabs, chips, cards). */
export const IDEATION_TYPE_ICONS: Record<IdeationType, LucideIcon> = {
	code_improvements: Zap,
	ui_ux_improvements: Palette,
	documentation_gaps: BookOpen,
	security_hardening: Shield,
	performance_optimizations: Gauge,
	code_quality: Code2,
};

interface TypeIconProps {
	readonly type: IdeationType;
	readonly className?: string;
}

export function TypeIcon({ type, className = "h-4 w-4" }: TypeIconProps) {
	const Icon = IDEATION_TYPE_ICONS[type] ?? Lightbulb;
	return <Icon className={className} aria-hidden="true" />;
}
