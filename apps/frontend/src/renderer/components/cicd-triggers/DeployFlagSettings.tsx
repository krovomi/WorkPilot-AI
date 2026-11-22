/**
 * The feature flag a critical verdict turns off, in the CI/CD settings (#366,
 * lot 4). When the deployed change sits behind a flag (Unleash, LaunchDarkly,
 * ConfigCat), turning it off is the quickest rollback: nothing is
 * redeployed, and a migration does not stand in the way. The watch falls
 * back to the deployment rollback when the flag cannot be switched. The
 * token is a secret: it comes back masked.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import type { CICDConfig } from "../../stores/cicd-triggers-store";
import { NativeSelect } from "../ui/native-select";
import { DraftField } from "./DraftField";

export const FLAG_PROVIDERS = ["unleash", "launchdarkly", "configcat"] as const;

type FlagField =
	| "rollback_flag_url"
	| "rollback_flag_key"
	| "rollback_flag_project"
	| "rollback_flag_environment"
	| "rollback_flag_user"
	| "rollback_flag_token";

const FIELDS: readonly { key: FlagField; type: string; placeholder?: string; only?: string }[] = [
	{ key: "rollback_flag_key", type: "text", placeholder: "new-checkout" },
	{ key: "rollback_flag_environment", type: "text", placeholder: "production" },
	{ key: "rollback_flag_project", type: "text", placeholder: "default" },
	{ key: "rollback_flag_url", type: "url", placeholder: "https://unleash.example.com" },
	{ key: "rollback_flag_user", type: "text", only: "configcat" },
	{ key: "rollback_flag_token", type: "password" },
];

interface DeployFlagSettingsProps {
	readonly config: CICDConfig | null;
	readonly onSave: (update: Partial<CICDConfig>) => void;
}

export function DeployFlagSettings({ config, onSave }: DeployFlagSettingsProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const provider = config?.rollback_flag_provider ?? "";
	return (
		<div className="space-y-2.5 border-t border-border pt-3" data-testid="deploy-flag-settings">
			<div className="wp-kicker">{t("cicdTriggers:flag.heading")}</div>
			<p className="wp-meta">{t("cicdTriggers:flag.description")}</p>
			<div className="space-y-1">
				<label htmlFor="cicd-rollback_flag_provider" className="wp-meta block">
					{t("cicdTriggers:flag.rollback_flag_provider")}
				</label>
				<NativeSelect
					id="cicd-rollback_flag_provider"
					value={provider}
					onChange={(e) => onSave({ rollback_flag_provider: e.target.value })}
					className="h-8 w-full text-xs"
				>
					<option value="">{t("cicdTriggers:flag.none")}</option>
					{FLAG_PROVIDERS.map((p) => (
						<option key={p} value={p}>
							{t(`cicdTriggers:flag.providers.${p}`)}
						</option>
					))}
				</NativeSelect>
			</div>
			{provider &&
				FIELDS.filter((f) => !f.only || f.only === provider).map(({ key, type, placeholder }) => (
					<DraftField
						key={key}
						id={`cicd-${key}`}
						label={t(`cicdTriggers:flag.${key}`)}
						type={type}
						value={config?.[key] ?? ""}
						placeholder={placeholder}
						onSave={(value) => onSave({ [key]: value })}
					/>
				))}
		</div>
	);
}
