/**
 * Who is on this server project right now, as avatars in the board's toolbar
 * (server mode). The server sends the room's roster on the project's stream.
 */

import { useTranslation } from "react-i18next";
import type { TeamMember } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { avatarColor, useCollaborationStore } from "../../stores/collaboration-store";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const MAX_VISIBLE = 5;

export function initialsOf(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.map((part) => part[0])
			.join("")
			.toUpperCase()
			.slice(0, 2) || "?"
	);
}

function UserAvatar({ user, isMe }: { user: TeamMember; isMe: boolean }) {
	const { t } = useTranslation("collaboration");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="flex h-7 w-7 cursor-default items-center justify-center rounded-full text-2xs font-semibold text-white ring-2 ring-background"
					style={{ backgroundColor: avatarColor(user.id) }}
					role="img"
					aria-label={user.name}
				>
					{initialsOf(user.name)}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{user.name}
				{isMe && <span className="ml-1 text-muted-foreground">{t("presence.you")}</span>}
			</TooltipContent>
		</Tooltip>
	);
}

export function PresenceIndicator() {
	const { t } = useTranslation("collaboration");
	const users = useCollaborationStore((s) => s.users);
	const me = useCollaborationStore((s) => s.me);
	const live = useCollaborationStore((s) => s.live);
	const show = useCollaborationStore((s) => s.settings.showPresenceIndicator);

	if (!show) return null;
	if (!live) {
		return <span className="text-xs text-muted-foreground">{t("presence.reconnecting")}</span>;
	}
	const visible = users.slice(0, MAX_VISIBLE);
	const overflow = users.length - visible.length;

	return (
		<TooltipProvider delayDuration={200}>
			<div className="flex items-center gap-1.5" data-testid="presence-indicator">
				<div className="flex -space-x-2">
					{visible.map((user) => (
						<UserAvatar key={user.id} user={user} isMe={user.id === me?.id} />
					))}
					{overflow > 0 && (
						<span
							className={cn(
								"flex h-7 w-7 items-center justify-center rounded-full bg-muted text-2xs font-medium",
								"text-muted-foreground ring-2 ring-background",
							)}
						>
							+{overflow}
						</span>
					)}
				</div>
				<span className="text-xs text-muted-foreground">
					{t("presence.usersOnline", { count: users.length })}
				</span>
			</div>
		</TooltipProvider>
	);
}
