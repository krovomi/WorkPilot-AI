import { Activity, AlertTriangle, BarChart3, Settings2, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	type AgentSafetyPageProps,
	RangeRow,
	SwitchRow,
	useAgentSafety,
} from "./agent-safety-controls";
import { SettingsSection } from "./SettingsSection";

const K = "sections.anomaly-detection";

/**
 * What lowers the trust score, as `apps/backend/security/anomaly_detector.py`
 * scores it (`ANOMALY_SCORE_IMPACT`): kept in step by hand, read by a test.
 */
export const SCORED_ANOMALIES = [
	{ type: "path_traversal_attempt", severity: "critical", impact: 30 },
	{ type: "mass_file_deletion", severity: "critical", impact: 25 },
	{ type: "unusual_command_execution", severity: "critical", impact: 20 },
	{ type: "sensitive_file_access", severity: "high", impact: 20 },
	{ type: "unexpected_network_access", severity: "high", impact: 20 },
	{ type: "system_config_modification", severity: "high", impact: 15 },
	{ type: "repetitive_errors", severity: "high", impact: 10 },
	{ type: "rapid_file_changes", severity: "medium", impact: 10 },
] as const;

/** Matched on whole names (`sensitive_path_match`): `.env.example` is not `.env`. */
const SENSITIVE = [
	".env",
	".git/",
	".ssh/",
	".aws/",
	".gnupg/",
	".kube/",
	".docker/",
	"id_rsa",
	"id_ed25519",
	"credentials",
	".netrc",
	".npmrc",
	".pypirc",
	"/etc/shadow",
];

const SEVERITY_COLOR: Record<string, string> = {
	critical: "bg-destructive/15 text-destructive",
	high: "bg-warning/15 text-warning",
	medium: "bg-info/15 text-info",
};

/**
 * Settings, Anomaly detection: the trust score each agent session starts at
 * 100, and what pauses or stops it. Saved with the other settings and sent to
 * every agent process; applied by `agents/safety_watch.py`.
 */
export function AnomalyDetectionSettings(props: AgentSafetyPageProps) {
	const { t } = useTranslation(["settings", "tasks"]);
	const { safety, update } = useAgentSafety(props);
	const { anomaly } = safety;

	return (
		<SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
			<div className="space-y-8">
				<SwitchRow
					id="anomaly-enabled"
					icon={<ShieldAlert className="h-5 w-5 text-primary" />}
					title={t(`${K}.enable.title`)}
					description={t(`${K}.enable.description`)}
					checked={anomaly.enabled}
					onChange={(enabled) => update("anomaly", { enabled })}
				/>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Activity className="h-4 w-4 text-primary" />
						{t(`${K}.trustScore.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">
						{t(`${K}.trustScore.description`)}
					</p>
					<div className="space-y-4">
						<RangeRow
							id="trust-score-pause"
							label={t(`${K}.trustScore.pauseThreshold`)}
							hint={t(`${K}.trustScore.pauseDescription`)}
							value={anomaly.pauseBelow}
							min={10}
							max={90}
							step={5}
							accent="accent-warning"
							onChange={(pauseBelow) => update("anomaly", { pauseBelow })}
						/>
						<RangeRow
							id="trust-score-stop"
							label={t(`${K}.trustScore.stopThreshold`)}
							hint={t(`${K}.trustScore.stopDescription`)}
							value={anomaly.stopBelow}
							min={0}
							max={anomaly.pauseBelow}
							step={5}
							accent="accent-destructive"
							onChange={(stopBelow) => update("anomaly", { stopBelow })}
						/>
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Settings2 className="h-4 w-4 text-primary" />
						{t(`${K}.detectionLimits.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">
						{t(`${K}.detectionLimits.description`)}
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<RangeRow
							id="anomaly-mass-deletion"
							label={t(`${K}.detectionLimits.massDeletionCount`)}
							hint={t(`${K}.detectionLimits.massDeletionDesc`)}
							value={anomaly.massDeletionCount}
							min={1}
							max={50}
							step={1}
							onChange={(massDeletionCount) => update("anomaly", { massDeletionCount })}
						/>
						<RangeRow
							id="anomaly-max-errors"
							label={t(`${K}.detectionLimits.maxRepetitiveErrors`)}
							hint={t(`${K}.detectionLimits.maxRepetitiveDesc`)}
							value={anomaly.maxErrorCount}
							min={3}
							max={100}
							step={1}
							onChange={(maxErrorCount) => update("anomaly", { maxErrorCount })}
						/>
						<RangeRow
							id="anomaly-rapid-window"
							label={t(`${K}.detectionLimits.rapidChangeWindow`)}
							hint={t(`${K}.detectionLimits.rapidChangeDesc`)}
							value={anomaly.rapidChangeWindowS}
							min={1}
							max={60}
							step={1}
							onChange={(rapidChangeWindowS) => update("anomaly", { rapidChangeWindowS })}
						/>
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<BarChart3 className="h-4 w-4 text-primary" />
						{t(`${K}.anomalyTypes.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">
						{t(`${K}.anomalyTypes.description`)}
					</p>
					<div className="rounded-md border border-border overflow-hidden">
						<table className="w-full text-xs">
							<thead>
								<tr className="border-b border-border bg-muted/40">
									<th className="text-left px-3 py-2 font-medium text-muted-foreground">
										{t(`${K}.anomalyTypes.anomaly`)}
									</th>
									<th className="text-left px-3 py-2 font-medium text-muted-foreground">
										{t(`${K}.anomalyTypes.severity`)}
									</th>
									<th className="text-right px-3 py-2 font-medium text-muted-foreground">
										{t(`${K}.anomalyTypes.scoreImpact`)}
									</th>
								</tr>
							</thead>
							<tbody>
								{SCORED_ANOMALIES.map((a) => (
									<tr key={a.type} className="border-b border-border last:border-0">
										<td className="px-3 py-1.5">{t(`tasks:safetyPause.types.${a.type}`)}</td>
										<td className="px-3 py-1.5">
											<span
												className={cn(
													"rounded-full px-2 py-0.5 text-3xs font-medium",
													SEVERITY_COLOR[a.severity],
												)}
											>
												{t(`${K}.anomalyTypes.severityLevels.${a.severity}`)}
											</span>
										</td>
										<td className="px-3 py-1.5 text-right font-mono text-destructive">
											{-a.impact}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-destructive" />
						{t(`${K}.sensitivePaths.title`)}
					</h4>
					<p className="text-xs text-muted-foreground">{t(`${K}.sensitivePaths.description`)}</p>
					<div className="flex flex-wrap gap-1.5 mt-2">
						{SENSITIVE.map((p) => (
							<code
								key={p}
								className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-mono text-destructive"
							>
								{p}
							</code>
						))}
					</div>
				</div>
			</div>
		</SettingsSection>
	);
}
