import {
	Bell,
	Bot,
	Brain,
	Bug,
	CalendarClock,
	Cloud,
	Code,
	FolderOpen,
	Globe,
	KeyRound,
	MessageSquare,
	Mic,
	Monitor,
	Package,
	Palette,
	Plug,
	Repeat,
	Settings2,
	Shield,
	ShieldAlert,
	Terminal,
	UserPlus,
	Users,
	Workflow,
	Zap,
} from "lucide-react";
import type { Tone } from "../charter";
import type { SettingsNavTheme } from "./settings-search";

/**
 * The groups of the Settings navigation and the pages in each. Every label goes
 * through i18n (`settings:nav.*`); a group carries a charter tone, which colours
 * its icon, its kicker and the kicker of each of its pages.
 */

export type SettingsTheme =
	| "project"
	| "integrations"
	| "interface"
	| "development"
	| "security"
	| "system";

// GitLab icon component (lucide-react doesn't have one)
function GitLabIcon({ className }: { readonly className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-label="GitLab">
			<title>GitLab</title>
			<path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z" />
		</svg>
	);
}

// Jira icon component (lucide-react doesn't include one)
function JiraIcon({ className }: { readonly className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-label="Jira">
			<title>Jira</title>
			<path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84h-9.63zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72a4.35 4.35 0 0 0 4.34 4.34v-9.57a.84.84 0 0 0-.84-.84H2z" />
		</svg>
	);
}

export interface SettingsThemeConfig extends SettingsNavTheme {
	readonly tone: Tone;
}

type Translate = {
	(key: string): string;
	(key: string, fallback: string): string;
	(key: string, options: Record<string, unknown>): string;
};

export function createSettingsThemes(t: Translate): Record<SettingsTheme, SettingsThemeConfig> {
	const nav = (id: string) => t(`settings:nav.sections.${id}`);
	const theme = (key: SettingsTheme) => ({
		title: t(`settings:nav.themes.${key}.title`),
		description: t(`settings:nav.themes.${key}.description`),
	});
	return {
		project: {
			...theme("project"),
			icon: Settings2,
			tone: "blue",
			sections: [{ id: "general", icon: Settings2, label: nav("general"), type: "project" }],
			priority: 1,
		},
		integrations: {
			...theme("integrations"),
			icon: Users,
			tone: "violet",
			sections: [
				{ id: "accounts", icon: Users, label: nav("accounts"), type: "app" },
				{ id: "github", icon: Globe, label: "GitHub", type: "project" },
				{ id: "gitlab", icon: GitLabIcon, label: "GitLab", type: "project" },
				{ id: "azure-devops", icon: Cloud, label: "Azure DevOps", type: "project" },
				{ id: "jev", icon: Zap, label: t("settings:jev.title"), type: "app" },
				{ id: "brain", icon: Brain, label: t("brain:settings.title"), type: "app" },
				{ id: "jira", icon: JiraIcon, label: "Jira", type: "project" },
				{ id: "figma", icon: Palette, label: "Figma", type: "project" },
				{ id: "linear", icon: Zap, label: "Linear", type: "project" },
				{ id: "cicd", icon: Workflow, label: t("settings:cicd.title", "Pipeline CI/CD"), type: "project" },
				{ id: "automations", icon: Repeat, label: t("settings:automations.title"), type: "project" },
				{ id: "board-mcp", icon: Plug, label: t("settings:boardMcp.navLabel"), type: "project" },
				{
					id: "teams",
					icon: MessageSquare,
					label: t("settings:channelNotifications.navLabel", "Notifications (Teams, Slack…)"),
					type: "project",
				},
				{
					id: "team-invitations",
					icon: UserPlus,
					label: t("settings:invitationsAdmin.navLabel", "Invitations (équipe)"),
					type: "app",
				},
				{ id: "server-tokens", icon: KeyRound, label: t("settings:serverTokens.navLabel"), type: "app" },
				{ id: "server-mcp", icon: Plug, label: t("settings:serverMcp.navLabel"), type: "app" },
				{ id: "server-needs-you", icon: Bell, label: t("settings:serverNeedsYou.navLabel"), type: "app" },
				{
					id: "server-collaboration",
					icon: Users,
					label: t("settings:serverCollaboration.navLabel"),
					type: "app",
				},
			],
			priority: 2,
		},
		interface: {
			...theme("interface"),
			icon: Palette,
			tone: "pink",
			sections: [
				{ id: "appearance", icon: Palette, label: nav("appearance"), type: "app" },
				{ id: "display", icon: Monitor, label: nav("display"), type: "app" },
				{ id: "language", icon: Globe, label: nav("language"), type: "app" },
				{ id: "voice-assistant", icon: Mic, label: t("voiceAssistant:settings.title"), type: "app" },
				{ id: "terminal-fonts", icon: Terminal, label: nav("terminal-fonts"), type: "app" },
			],
			priority: 3,
		},
		development: {
			...theme("development"),
			icon: Code,
			tone: "green",
			sections: [
				{ id: "devtools", icon: Code, label: nav("devtools"), type: "app" },
				{ id: "paths", icon: FolderOpen, label: t("settings:sections.paths.title"), type: "app" },
				{ id: "agent", icon: Bot, label: nav("agent"), type: "app" },
				{ id: "swarm-mode", icon: Zap, label: t("swarm:title", "Swarm Mode"), type: "app" },
			],
			priority: 4,
		},
		security: {
			...theme("security"),
			icon: Shield,
			tone: "orange",
			sections: [
				{
					id: "guardrails",
					icon: Shield,
					label: t("settings:guardrails.title", "Agent Guardrails"),
					type: "app",
				},
				{
					id: "anomaly-detection",
					icon: ShieldAlert,
					label: t("settings:sections.anomaly-detection.title"),
					type: "app",
				},
				{ id: "sandbox", icon: Shield, label: t("settings:sections.sandbox.title"), type: "app" },
			],
			priority: 5,
		},
		system: {
			...theme("system"),
			icon: Package,
			tone: "muted",
			sections: [
				{ id: "notifications", icon: Bell, label: nav("notifications"), type: "app" },
				{ id: "debug", icon: Bug, label: nav("debug"), type: "app" },
				{ id: "scheduler", icon: CalendarClock, label: nav("scheduler"), type: "app" },
				{ id: "updates", icon: Package, label: nav("updates"), type: "app" },
			],
			priority: 6,
		},
	};
}

/** The group a page belongs to, for the kicker above its title. */
export function themeOfSection(
	themes: Record<SettingsTheme, SettingsThemeConfig>,
	sectionId: string,
): SettingsThemeConfig | undefined {
	return Object.values(themes).find((theme) => theme.sections.some((s) => s.id === sectionId));
}
