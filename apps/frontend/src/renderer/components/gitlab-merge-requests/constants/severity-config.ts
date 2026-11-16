/**
 * Severity configuration for GitLab MR review findings
 */

import {
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	Code,
	FileText,
	Shield,
	TestTube,
	XCircle,
	Zap,
} from "lucide-react";

export type SeverityGroup = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: SeverityGroup[] = [
	"critical",
	"high",
	"medium",
	"low",
];

export const SEVERITY_CONFIG: Record<
	SeverityGroup,
	{
		labelKey: string;
		color: string;
		bgColor: string;
		icon: typeof XCircle;
		descriptionKey: string;
	}
> = {
	critical: {
		labelKey: "findings.severity.critical",
		color: "text-destructive",
		bgColor: "bg-destructive/10 border-destructive/30",
		icon: XCircle,
		descriptionKey: "findings.severity.criticalDesc",
	},
	high: {
		labelKey: "findings.severity.high",
		color: "text-orange-500",
		bgColor: "bg-orange-500/10 border-orange-500/30",
		icon: AlertTriangle,
		descriptionKey: "findings.severity.highDesc",
	},
	medium: {
		labelKey: "findings.severity.medium",
		color: "text-warning",
		bgColor: "bg-warning/10 border-warning/30",
		icon: AlertCircle,
		descriptionKey: "findings.severity.mediumDesc",
	},
	low: {
		labelKey: "findings.severity.low",
		color: "text-blue-500",
		bgColor: "bg-blue-500/10 border-blue-500/30",
		icon: CheckCircle,
		descriptionKey: "findings.severity.lowDesc",
	},
};

export const CATEGORY_ICONS: Record<string, typeof Shield> = {
	security: Shield,
	quality: Code,
	docs: FileText,
	test: TestTube,
	performance: Zap,
	style: Code,
	pattern: Code,
};

export function getCategoryIcon(category: string) {
	return CATEGORY_ICONS[category] ?? Code;
}
