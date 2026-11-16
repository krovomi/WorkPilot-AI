/**
 * SeverityGroupHeader - Collapsible header for a severity group with selection checkbox
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Checkbox } from "../../ui/checkbox";
import type { SeverityGroup } from "../constants/severity-config";
import { SEVERITY_CONFIG } from "../constants/severity-config";

interface SeverityGroupHeaderProps {
	severity: SeverityGroup;
	count: number;
	selectedCount: number;
	expanded: boolean;
	onToggle: () => void;
	onSelectAll: () => void;
}

export function SeverityGroupHeader({
	severity,
	count,
	selectedCount,
	expanded,
	onToggle,
	onSelectAll,
}: SeverityGroupHeaderProps) {
	const { t } = useTranslation("gitlab");
	const config = SEVERITY_CONFIG[severity];
	const Icon = config.icon;
	const label = t(config.labelKey);
	let checked: boolean | "indeterminate" = false;
	if (count > 0 && selectedCount === count) checked = true;
	else if (selectedCount > 0) checked = "indeterminate";

	// Two controls side by side: the checkbox used to be a div inside the
	// toggle button, out of reach of the keyboard and of a screen reader.
	return (
		<div className="flex items-center gap-3 pl-3 rounded-t-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
			<Checkbox
				checked={checked}
				onCheckedChange={onSelectAll}
				aria-label={t("findings.selectSeverityGroup", { severity: label })}
			/>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex-1 flex items-center justify-between py-3 pr-3"
			>
				<div className="flex items-center gap-3">
					<Icon className={cn("h-4 w-4", config.color)} />
					<span className={cn("font-medium text-sm", config.color)}>
						{label}
					</span>
					<Badge variant="secondary" className="text-xs">
						{count}
					</Badge>
					<span className="text-xs text-muted-foreground hidden sm:inline">
						{t(config.descriptionKey)}
					</span>
				</div>
				{expanded ? (
					<ChevronDown className="h-4 w-4 text-muted-foreground" />
				) : (
					<ChevronRight className="h-4 w-4 text-muted-foreground" />
				)}
			</button>
		</div>
	);
}
