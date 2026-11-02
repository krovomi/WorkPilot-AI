/**
 * The person's collaboration settings for server projects: what the board
 * shows of the team, what they are told, and how an edit that meets a
 * teammate's change is settled. Kept on this computer
 * (`stores/collaboration-store.ts`).
 */

import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
	type CollaborationSettings as Settings,
	type ConflictStrategy,
	useCollaborationStore,
} from "../../stores/collaboration-store";
import { Label } from "../ui/label";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

const STRATEGIES: ConflictStrategy[] = ["manual", "last_write_wins", "first_write_wins"];

type Toggle = {
	[K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

const SECTIONS: Array<{ key: string; toggles: Array<{ setting: Toggle; label: string }> }> = [
	{
		key: "team",
		toggles: [
			{ setting: "showPresenceIndicator", label: "settings.team.presence" },
			{ setting: "chatEnabled", label: "settings.team.chat" },
		],
	},
	{
		key: "notifications",
		toggles: [
			{ setting: "notifyUserJoinLeave", label: "settings.notifications.userJoinLeave" },
			{ setting: "notifyTaskLocks", label: "settings.notifications.taskLocks" },
			{ setting: "notifyAgentActivity", label: "settings.notifications.agentActivity" },
			{ setting: "notifyChatMentions", label: "settings.notifications.chatMentions" },
		],
	},
];

export function CollaborationSettings() {
	const { t } = useTranslation("collaboration");
	const settings = useCollaborationStore((s) => s.settings);
	const updateSettings = useCollaborationStore((s) => s.updateSettings);

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
					<Users className="h-5 w-5 text-primary" />
				</div>
				<div>
					<h3 className="text-base font-semibold">{t("settings.title")}</h3>
					<p className="text-sm text-muted-foreground">{t("settings.description")}</p>
				</div>
			</div>

			{SECTIONS.map((section) => (
				<div key={section.key} className="space-y-3">
					<Separator />
					<div>
						<Label className="text-sm font-medium">{t(`settings.${section.key}.title`)}</Label>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{t(`settings.${section.key}.description`)}
						</p>
					</div>
					{section.toggles.map(({ setting, label }) => (
						<div key={setting} className="flex items-center justify-between">
							<Label htmlFor={`collab-${setting}`} className="text-sm">
								{t(label)}
							</Label>
							<Switch
								id={`collab-${setting}`}
								checked={settings[setting]}
								onCheckedChange={(checked) => updateSettings({ [setting]: checked })}
							/>
						</div>
					))}
				</div>
			))}

			<Separator />
			<div className="space-y-3">
				<div>
					<Label className="text-sm font-medium">{t("settings.conflictStrategy.title")}</Label>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{t("settings.conflictStrategy.description")}
					</p>
				</div>
				<div className="grid gap-2 sm:grid-cols-3">
					{STRATEGIES.map((strategy) => (
						<button
							type="button"
							key={strategy}
							aria-pressed={settings.conflictStrategy === strategy}
							onClick={() => updateSettings({ conflictStrategy: strategy })}
							className={cn(
								"rounded-lg border-2 p-3 text-left transition-all",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								settings.conflictStrategy === strategy
									? "border-primary bg-primary/5"
									: "border-border hover:border-primary/50 hover:bg-accent/50",
							)}
						>
							<div className="text-sm font-medium">
								{t(`settings.conflictStrategy.${strategy}`)}
							</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								{t(`settings.conflictStrategy.${strategy}Desc`)}
							</div>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
