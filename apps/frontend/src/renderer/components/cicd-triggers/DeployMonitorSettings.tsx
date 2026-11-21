/**
 * What to watch after a deployment, in the CI/CD settings (#366): the health
 * check and one metric source (Prometheus, Datadog, New Relic or CloudWatch;
 * their URLs and keys stay in the project's encrypted settings, never in a
 * committed file), the window, and the automatic rollback, off unless turned
 * on here.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import type { CICDConfig } from "../../stores/cicd-triggers-store";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";
import { DraftField } from "./DraftField";

type TextField = {
	[K in keyof CICDConfig]: CICDConfig[K] extends string ? K : never;
}[keyof CICDConfig];

interface FieldSpec {
	readonly key: TextField;
	readonly type: string;
	readonly placeholder?: string;
}

export const METRIC_SOURCES = ["prometheus", "datadog", "newrelic", "cloudwatch"] as const;
export type MetricSourceKind = (typeof METRIC_SOURCES)[number];

// The closed lists the runner accepts (apps/backend/deploy_watch/sources.py).
const DATADOG_SITES = [
	"datadoghq.com",
	"us3.datadoghq.com",
	"us5.datadoghq.com",
	"datadoghq.eu",
	"ap1.datadoghq.com",
	"ap2.datadoghq.com",
	"ddog-gov.com",
];
const NEWRELIC_REGIONS = ["us", "eu"];

const SOURCE_FIELDS: Readonly<Record<MetricSourceKind, readonly FieldSpec[]>> = {
	prometheus: [
		{ key: "monitor_prometheus_url", type: "url", placeholder: "https://prometheus.example.com" },
		{ key: "monitor_prometheus_token", type: "password" },
	],
	datadog: [
		{ key: "monitor_datadog_api_key", type: "password" },
		{ key: "monitor_datadog_app_key", type: "password" },
	],
	newrelic: [
		{ key: "monitor_newrelic_account_id", type: "text", placeholder: "1234567" },
		{ key: "monitor_newrelic_api_key", type: "password" },
	],
	cloudwatch: [
		{ key: "monitor_aws_region", type: "text", placeholder: "eu-west-3" },
		{ key: "monitor_aws_access_key_id", type: "text" },
		{ key: "monitor_aws_secret_access_key", type: "password" },
		{ key: "monitor_aws_session_token", type: "password" },
	],
};

const DURATIONS: readonly FieldSpec[] = [
	{ key: "monitor_window_minutes", type: "number", placeholder: "15" },
	{ key: "monitor_deploy_wait_minutes", type: "number", placeholder: "5" },
];

/** The source the settings name; Prometheus when they name none. */
export function metricSource(config: CICDConfig | null): MetricSourceKind {
	const value = config?.monitor_source ?? "";
	return (METRIC_SOURCES as readonly string[]).includes(value) ? (value as MetricSourceKind) : "prometheus";
}

interface DeployMonitorSettingsProps {
	readonly config: CICDConfig | null;
	readonly onSave: (update: Partial<CICDConfig>) => void;
}

export function DeployMonitorSettings({ config, onSave }: DeployMonitorSettingsProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const source = metricSource(config);
	const field = ({ key, type, placeholder }: FieldSpec) => (
		<DraftField
			key={key}
			id={`cicd-${key}`}
			label={t(`cicdTriggers:monitor.${key}`)}
			type={type}
			value={config?.[key] ?? ""}
			placeholder={placeholder}
			onSave={(value) => onSave({ [key]: value })}
		/>
	);
	const choice = (key: TextField, options: readonly string[], fallback: string) => (
		<div className="space-y-1">
			<label htmlFor={`cicd-${key}`} className="wp-meta block">
				{t(`cicdTriggers:monitor.${key}`)}
			</label>
			<NativeSelect
				id={`cicd-${key}`}
				value={config?.[key] || fallback}
				onChange={(e) => onSave({ [key]: e.target.value })}
				className="h-8 w-full text-xs"
			>
				{options.map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
			</NativeSelect>
		</div>
	);

	return (
		<div className="space-y-2.5 border-t border-border pt-3" data-testid="deploy-monitor-settings">
			<div className="wp-kicker">{t("cicdTriggers:monitor.heading")}</div>
			<p className="wp-meta">{t("cicdTriggers:monitor.description")}</p>
			{field({ key: "monitor_health_url", type: "url", placeholder: "https://app.example.com/health" })}
			<div className="space-y-1">
				<label htmlFor="cicd-monitor_source" className="wp-meta block">
					{t("cicdTriggers:monitor.monitor_source")}
				</label>
				<NativeSelect
					id="cicd-monitor_source"
					value={source}
					onChange={(e) => onSave({ monitor_source: e.target.value })}
					className="h-8 w-full text-xs"
				>
					{METRIC_SOURCES.map((kind) => (
						<option key={kind} value={kind}>
							{t(`cicdTriggers:monitor.sources.${kind}`)}
						</option>
					))}
				</NativeSelect>
			</div>
			{source === "datadog" && choice("monitor_datadog_site", DATADOG_SITES, "datadoghq.com")}
			{source === "newrelic" && choice("monitor_newrelic_region", NEWRELIC_REGIONS, "us")}
			{SOURCE_FIELDS[source].map(field)}
			{DURATIONS.map(field)}
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
			<p className="wp-meta">{t(`cicdTriggers:monitor.queryHint.${source}`)}</p>
			<p className="wp-meta">{t("cicdTriggers:monitor.fileHint")}</p>
		</div>
	);
}
