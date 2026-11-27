import { GitMerge, Info, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/types";
import {
	APPROVAL_TIER_MODES,
	normalizeApprovalTierMode,
} from "../../../shared/utils/approval-tiers";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";

const K = "sections.approvals";
const TIERS = ["N0", "N1", "N2", "N3"] as const;

interface ApprovalTiersSettingsProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings, Approval tiers: whether a task's green pull request gets its tier
 * (N0 to N3, read without a model by `apps/backend/approvals`) and merges by
 * itself when the tier allows it. Sent to the PR follow-through as
 * `WORKPILOT_APPROVALS` (`main/agent/approvals-env.ts`); a project's
 * `workpilot.policy.yaml` can only restrict it.
 */
export function ApprovalTiersSettings({ settings, onSettingsChange }: ApprovalTiersSettingsProps) {
	const { t } = useTranslation("settings");
	const mode = normalizeApprovalTierMode(settings.approvalTiers);

	return (
		<SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
			<div className="space-y-8">
				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<GitMerge className="h-4 w-4 text-primary" />
						{t(`${K}.mode.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">{t(`${K}.mode.description`)}</p>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						{APPROVAL_TIER_MODES.map((id) => (
							<button
								type="button"
								key={id}
								data-testid={`approval-mode-${id}`}
								onClick={() => onSettingsChange({ ...settings, approvalTiers: id })}
								aria-pressed={mode === id}
								className={cn(
									"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
									mode === id
										? "border-primary bg-primary/5 ring-1 ring-primary"
										: "border-border hover:bg-accent/50",
								)}
							>
								<span className="text-sm font-medium">{t(`${K}.mode.${id}.label`)}</span>
								<span className="text-xs text-muted-foreground">
									{t(`${K}.mode.${id}.description`)}
								</span>
							</button>
						))}
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Layers className="h-4 w-4 text-primary" />
						{t(`${K}.tiers.title`)}
					</h4>
					<ul className="space-y-2">
						{TIERS.map((tier) => (
							<li key={tier} className="flex items-start gap-3 text-sm">
								<span className="mt-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
									{t(`${K}.tiers.${tier}.badge`)}
								</span>
								<span className="text-muted-foreground">{t(`${K}.tiers.${tier}.when`)}</span>
							</li>
						))}
					</ul>
				</div>

				<p className="flex items-start gap-2 text-xs text-muted-foreground">
					<Info className="mt-0.5 h-4 w-4 shrink-0" />
					{t(`${K}.policyNote`)}
				</p>
			</div>
		</SettingsSection>
	);
}
