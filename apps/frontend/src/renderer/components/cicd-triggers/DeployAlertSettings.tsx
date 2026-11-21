/**
 * Where the alert of a bad deployment goes, in the CI/CD settings (#366):
 * a Slack incoming webhook (or any Slack-compatible one), a PagerDuty
 * routing key, an SMTP server. A degraded verdict goes to Slack and e-mail,
 * a critical one also pages through PagerDuty. The webhook URL, the routing
 * key and the SMTP password are secrets: they come back masked.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import type { CICDConfig } from "../../stores/cicd-triggers-store";
import { NativeSelect } from "../ui/native-select";
import { DraftField } from "./DraftField";

type AlertField =
	| "alert_slack_webhook_url"
	| "alert_pagerduty_routing_key"
	| "alert_email_to"
	| "alert_email_from"
	| "alert_smtp_host"
	| "alert_smtp_port"
	| "alert_smtp_user"
	| "alert_smtp_password";

const FIELDS: readonly { key: AlertField; type: string; placeholder?: string }[] = [
	{ key: "alert_slack_webhook_url", type: "password" },
	{ key: "alert_pagerduty_routing_key", type: "password" },
	{ key: "alert_email_to", type: "text", placeholder: "oncall@example.com" },
	{ key: "alert_email_from", type: "text", placeholder: "ci@example.com" },
	{ key: "alert_smtp_host", type: "text", placeholder: "smtp.example.com" },
	{ key: "alert_smtp_port", type: "number", placeholder: "587" },
	{ key: "alert_smtp_user", type: "text" },
	{ key: "alert_smtp_password", type: "password" },
];

const PAGERDUTY_REGIONS = ["us", "eu"];

interface DeployAlertSettingsProps {
	readonly config: CICDConfig | null;
	readonly onSave: (update: Partial<CICDConfig>) => void;
}

export function DeployAlertSettings({ config, onSave }: DeployAlertSettingsProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const fields = FIELDS.map(({ key, type, placeholder }) => (
		<DraftField
			key={key}
			id={`cicd-${key}`}
			label={t(`cicdTriggers:alerts.${key}`)}
			type={type}
			value={config?.[key] ?? ""}
			placeholder={placeholder}
			onSave={(value) => onSave({ [key]: value })}
		/>
	));
	return (
		<div className="space-y-2.5 border-t border-border pt-3" data-testid="deploy-alert-settings">
			<div className="wp-kicker">{t("cicdTriggers:alerts.heading")}</div>
			<p className="wp-meta">{t("cicdTriggers:alerts.description")}</p>
			{fields.slice(0, 2)}
			<div className="space-y-1">
				<label htmlFor="cicd-alert_pagerduty_region" className="wp-meta block">
					{t("cicdTriggers:alerts.alert_pagerduty_region")}
				</label>
				<NativeSelect
					id="cicd-alert_pagerduty_region"
					value={config?.alert_pagerduty_region || "us"}
					onChange={(e) => onSave({ alert_pagerduty_region: e.target.value })}
					className="h-8 w-full text-xs"
				>
					{PAGERDUTY_REGIONS.map((region) => (
						<option key={region} value={region}>
							{region}
						</option>
					))}
				</NativeSelect>
			</div>
			{fields.slice(2)}
			<p className="wp-meta">{t("cicdTriggers:alerts.offlineHint")}</p>
		</div>
	);
}
