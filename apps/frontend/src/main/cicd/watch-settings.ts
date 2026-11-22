/**
 * The settings of the watch after a deployment that lot 3 of #366 added: the
 * metric source other than Prometheus (Datadog, New Relic, CloudWatch, and
 * Grafana since lot 4) and
 * the alert channels (Slack, PagerDuty, e-mail).
 *
 * Renderer field → `.workpilot/.env` key, like the rest of the CI/CD
 * settings (`cicd-triggers-handlers.ts`). A key classed `encrypted` in
 * `project-env-secrets.json` is a secret: the renderer only ever sees
 * MASKED_TOKEN for it, and sending MASKED_TOKEN back keeps the stored value.
 * The runner validates every value again where it is used
 * (`apps/backend/deploy_watch/sources.py`, `alerts.py`).
 */

import projectEnvSecrets from "../../shared/constants/project-env-secrets.json";

const ENCRYPTED: ReadonlySet<string> = new Set(projectEnvSecrets.encrypted);

export const WATCH_SOURCE_KEYS: Readonly<Record<string, string>> = {
	monitor_source: "CICD_MONITOR_SOURCE",
	monitor_datadog_site: "CICD_MONITOR_DATADOG_SITE",
	monitor_datadog_api_key: "CICD_MONITOR_DATADOG_API_KEY",
	monitor_datadog_app_key: "CICD_MONITOR_DATADOG_APP_KEY",
	monitor_newrelic_region: "CICD_MONITOR_NEWRELIC_REGION",
	monitor_newrelic_account_id: "CICD_MONITOR_NEWRELIC_ACCOUNT_ID",
	monitor_newrelic_api_key: "CICD_MONITOR_NEWRELIC_API_KEY",
	monitor_aws_region: "CICD_MONITOR_AWS_REGION",
	monitor_aws_access_key_id: "CICD_MONITOR_AWS_ACCESS_KEY_ID",
	monitor_aws_secret_access_key: "CICD_MONITOR_AWS_SECRET_ACCESS_KEY",
	monitor_aws_session_token: "CICD_MONITOR_AWS_SESSION_TOKEN",
	// Grafana (#366, lot 4): its URL, a service account token, a data source.
	monitor_grafana_url: "CICD_MONITOR_GRAFANA_URL",
	monitor_grafana_token: "CICD_MONITOR_GRAFANA_TOKEN",
	monitor_grafana_datasource_uid: "CICD_MONITOR_GRAFANA_DATASOURCE_UID",
};

/** The feature flag a critical verdict turns off before redeploying (lot 4). */
export const WATCH_FLAG_KEYS: Readonly<Record<string, string>> = {
	rollback_flag_provider: "CICD_ROLLBACK_FLAG_PROVIDER",
	rollback_flag_url: "CICD_ROLLBACK_FLAG_URL",
	rollback_flag_key: "CICD_ROLLBACK_FLAG_KEY",
	rollback_flag_project: "CICD_ROLLBACK_FLAG_PROJECT",
	rollback_flag_environment: "CICD_ROLLBACK_FLAG_ENVIRONMENT",
	rollback_flag_user: "CICD_ROLLBACK_FLAG_USER",
	rollback_flag_token: "CICD_ROLLBACK_FLAG_TOKEN",
};

export const WATCH_ALERT_KEYS: Readonly<Record<string, string>> = {
	alert_slack_webhook_url: "CICD_ALERT_SLACK_WEBHOOK_URL",
	alert_pagerduty_routing_key: "CICD_ALERT_PAGERDUTY_ROUTING_KEY",
	alert_pagerduty_region: "CICD_ALERT_PAGERDUTY_REGION",
	alert_email_to: "CICD_ALERT_EMAIL_TO",
	alert_email_from: "CICD_ALERT_EMAIL_FROM",
	alert_smtp_host: "CICD_ALERT_SMTP_HOST",
	alert_smtp_port: "CICD_ALERT_SMTP_PORT",
	alert_smtp_user: "CICD_ALERT_SMTP_USER",
	alert_smtp_password: "CICD_ALERT_SMTP_PASSWORD", // pragma: allowlist secret (a key name)
};

/** What getConfig shows for a secret that is set; sent back, it means "unchanged". */
export const MASKED_TOKEN = "***";

/** A CI/CD key whose value never goes to the renderer. */
export function isCicdSecret(key: string): boolean {
	return ENCRYPTED.has(key);
}

/** The lot 3 fields as the renderer may see them: secrets masked. */
export function watchSettingsView(config: Record<string, string>): Record<string, string> {
	const view: Record<string, string> = {};
	for (const [field, key] of Object.entries({ ...WATCH_SOURCE_KEYS, ...WATCH_ALERT_KEYS, ...WATCH_FLAG_KEYS })) {
		const value = config[key] ?? "";
		view[field] = isCicdSecret(key) ? (value ? MASKED_TOKEN : "") : value;
	}
	return view;
}

// The key a source cannot work without, besides Prometheus' URL.
const SOURCE_KEY: Readonly<Record<string, string>> = {
	datadog: "CICD_MONITOR_DATADOG_API_KEY",
	newrelic: "CICD_MONITOR_NEWRELIC_API_KEY",
	cloudwatch: "CICD_MONITOR_AWS_SECRET_ACCESS_KEY",
	grafana: "CICD_MONITOR_GRAFANA_URL",
};

/** The CI/CD settings name something to watch after a deployment. */
export function watchConfigured(config: Record<string, string>): boolean {
	if ((config.CICD_MONITOR_HEALTH_URL ?? "").trim()) return true;
	const source = (config.CICD_MONITOR_SOURCE ?? "").trim().toLowerCase();
	const key = SOURCE_KEY[source] ?? "CICD_MONITOR_PROMETHEUS_URL";
	return Boolean((config[key] ?? "").trim());
}
