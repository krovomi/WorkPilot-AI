import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/types";
import { normalizeApprovalTierMode } from "../../../shared/utils/approval-tiers";
import { Switch } from "../ui/switch";

const K = "sections.approvals.express";

interface ExpressLaneSettingsProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings, Approval tiers, Express lane: the projects' own Dependabot and
 * Renovate pull requests, merged by themselves in N0 by the main process
 * (`main/express-lane.ts`). Off by default; it runs only while the tiers
 * enforce, which the note under the switch says.
 */
export function ExpressLaneSettings({ settings, onSettingsChange }: ExpressLaneSettingsProps) {
	const { t } = useTranslation("settings");
	const enforced = normalizeApprovalTierMode(settings.approvalTiers) === "enforce";
	const on = settings.expressLane === true;

	return (
		<div data-testid="express-lane-settings">
			<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
				<Zap className="h-4 w-4 text-primary" />
				{t(`${K}.title`)}
			</h4>
			<p className="text-xs text-muted-foreground mb-3">{t(`${K}.description`)}</p>
			<div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
				<div className="space-y-1">
					<span className="text-sm font-medium">{t(`${K}.toggle`)}</span>
					<p className="text-xs text-muted-foreground">{t(`${K}.toggleDescription`)}</p>
					{on && !enforced && (
						<p data-testid="express-lane-needs-enforce" className="text-xs text-warning">
							{t(`${K}.needsEnforce`)}
						</p>
					)}
				</div>
				<Switch
					data-testid="express-lane-toggle"
					checked={on}
					onCheckedChange={(checked) => onSettingsChange({ ...settings, expressLane: checked })}
					aria-label={t(`${K}.toggle`)}
				/>
			</div>
		</div>
	);
}
