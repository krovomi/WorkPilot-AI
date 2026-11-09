/** Team Bot (Slack / Microsoft Teams incoming webhook): shared shapes. */

export type TeamBotKind = "slack" | "teams";
export type TeamBotSeverity = "info" | "warning" | "critical";
export type TeamBotEvent =
	| "agent_started"
	| "agent_finished"
	| "cost_alert"
	| "guardrail_blocked"
	| "blast_radius_high"
	| "custom";

/**
 * The configuration. `webhook_url` is a credential: the main process keeps it
 * encrypted and hands the renderer MASKED_SECRET in its place.
 */
export interface TeamBotConfig {
	kind: TeamBotKind;
	webhook_url: string;
	default_channel?: string;
	enabled?: boolean;
	tags?: string[];
}

export interface TeamBotNotification {
	event: TeamBotEvent;
	title: string;
	summary: string;
	fields?: Record<string, unknown>;
	severity?: TeamBotSeverity;
}
