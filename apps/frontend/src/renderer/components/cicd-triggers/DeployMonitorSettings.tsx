/**
 * What to watch after a deployment, in the CI/CD settings (#366): the health
 * check and Prometheus (their URLs and token stay in the project's encrypted
 * settings, never in a committed file), the window, and the automatic
 * rollback, off unless turned on here.
 */

import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CICDConfig } from "../../stores/cicd-triggers-store";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type TextField =
	| "monitor_health_url"
	| "monitor_prometheus_url"
	| "monitor_prometheus_token"
	| "monitor_window_minutes"
	| "monitor_deploy_wait_minutes";

const FIELDS: readonly { key: TextField; type: string; placeholder?: string }[] = [
	{ key: "monitor_health_url", type: "url", placeholder: "https://app.example.com/health" },
	{ key: "monitor_prometheus_url", type: "url", placeholder: "https://prometheus.example.com" },
	{ key: "monitor_prometheus_token", type: "password" },
	{ key: "monitor_window_minutes", type: "number", placeholder: "15" },
	{ key: "monitor_deploy_wait_minutes", type: "number", placeholder: "5" },
];

interface DeployMonitorSettingsProps {
	readonly config: CICDConfig | null;
	readonly onSave: (update: Partial<CICDConfig>) => void;
}

export function DeployMonitorSettings({ config, onSave }: DeployMonitorSettingsProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const [draft, setDraft] = useState<Partial<Record<TextField, string>>>({});

	return (
		<div className="space-y-2.5 border-t border-border pt-3" data-testid="deploy-monitor-settings">
			<div className="wp-kicker">{t("cicdTriggers:monitor.heading")}</div>
			<p className="wp-meta">{t("cicdTriggers:monitor.description")}</p>
			{FIELDS.map(({ key, type, placeholder }) => (
				<div key={key} className="space-y-1">
					<label htmlFor={`cicd-${key}`} className="wp-meta block">
						{t(`cicdTriggers:monitor.${key}`)}
					</label>
					<Input
						id={`cicd-${key}`}
						type={type}
						value={draft[key] ?? config?.[key] ?? ""}
						placeholder={placeholder}
						onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
						onBlur={() => {
							const value = draft[key];
							if (value === undefined) return;
							if (value !== (config?.[key] ?? "")) onSave({ [key]: value.trim() });
							setDraft(({ [key]: _saved, ...rest }) => rest);
						}}
						className="h-8 font-mono text-xs"
					/>
				</div>
			))}
			<label
				htmlFor="cicd-auto_rollback"
				className="flex cursor-pointer items-center justify-between gap-3 text-sm"
			>
				{t("cicdTriggers:monitor.auto_rollback")}
				<Switch
					id="cicd-auto_rollback"
					checked={config?.auto_rollback ?? false}
					onCheckedChange={(checked) => onSave({ auto_rollback: checked })}
				/>
			</label>
			<p className="wp-meta">{t("cicdTriggers:monitor.autoRollbackHint")}</p>
			<p className="wp-meta">{t("cicdTriggers:monitor.fileHint")}</p>
		</div>
	);
}
