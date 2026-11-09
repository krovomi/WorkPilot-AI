import { AlertTriangle, CheckCircle2, MessageSquare, Send } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTeamBotStore } from "../../stores/team-bot-store";
import {
	CharterButton,
	Chip,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
} from "../charter";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

const PLATFORMS = ["slack", "teams"] as const;
const EVENTS = ["agentDone", "costAlert", "guardrailBlock", "blastRadius"] as const;

/** Team notifications on Slack or Microsoft Teams, through an incoming webhook. */
export function TeamBotSettings() {
	const { t } = useTranslation(["teamBot", "navigation"]);
	const { config, testing, lastResult, lastError, setConfig, sendTest } = useTeamBotStore();
	const load = useTeamBotStore((s) => s.load);

	// The main process keeps the configuration (its webhook URL masked here).
	useEffect(() => {
		void load();
	}, [load]);

	return (
		<ModuleStage scroll="page" data-testid="team-bot-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("teamBot:title")}
				description={t("teamBot:description")}
				icon={MessageSquare}
				tone="violet"
				actions={
					<CharterButton
						variant="primary"
						icon={Send}
						busy={testing}
						onClick={() => void sendTest()}
						disabled={testing || !config.webhook_url.trim()}
					>
						{testing ? t("teamBot:sending") : t("teamBot:sendTest")}
					</CharterButton>
				}
			/>
			<Page className="space-y-4">
				{lastResult === "ok" && (
					<Notice tone="green" icon={CheckCircle2}>
						{t("teamBot:ok")}
					</Notice>
				)}
				{lastResult === "error" && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{lastError ?? t("teamBot:error")}
					</Notice>
				)}
				<Section kicker={t("teamBot:kickers.connection")} title={t("teamBot:connectionTitle")}>
					<Panel className="space-y-4">
						<div className="space-y-1.5">
							<span className="wp-kicker block">{t("teamBot:platform")}</span>
							<div className="wp-chips">
								{PLATFORMS.map((kind) => (
									<Chip
										key={kind}
										tone="violet"
										pressed={config.kind === kind}
										onClick={() => setConfig({ kind })}
									>
										{t(`teamBot:platforms.${kind}`)}
									</Chip>
								))}
							</div>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="team-bot-webhook" className="wp-kicker block">
								{t("teamBot:webhookUrl")}
							</label>
							<Input
								id="team-bot-webhook"
								value={config.webhook_url}
								onChange={(e) => setConfig({ webhook_url: e.target.value })}
								placeholder={t(`teamBot:webhookPlaceholder.${config.kind}`)}
								type="url"
								className="font-mono text-xs"
							/>
						</div>
						<label htmlFor="team-bot-enabled" className="flex cursor-pointer items-center justify-between gap-3 text-sm">
							{t("teamBot:enabled")}
							<Switch
								id="team-bot-enabled"
								checked={config.enabled ?? false}
								onCheckedChange={(checked) => setConfig({ enabled: checked })}
							/>
						</label>
					</Panel>
				</Section>
				<Section kicker={t("teamBot:kickers.events")} title={t("teamBot:eventsTitle")} description={t("teamBot:help")}>
					<div className="wp-chips">
						{EVENTS.map((event) => (
							<Chip key={event} tone={config.enabled ? "green" : "muted"}>
								{t(`teamBot:events.${event}`)}
							</Chip>
						))}
					</div>
				</Section>
			</Page>
		</ModuleStage>
	);
}
