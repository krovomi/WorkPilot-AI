/**
 * The team of a server project, in its board's toolbar (server mode): while
 * the board is shown, the window is in the project's room. Shows who is on
 * it and the chat button, and holds the chat panel and the team's toasts.
 */

import { useEffect } from "react";
import { useCollaborationStore } from "../../stores/collaboration-store";
import { CollaborationNotifications } from "./CollaborationNotifications";
import { PresenceIndicator } from "./PresenceIndicator";
import { TeamChat, TeamChatButton } from "./TeamChat";

export function TeamRoomBar({ projectId }: { projectId: string }) {
	const join = useCollaborationStore((s) => s.join);
	const leave = useCollaborationStore((s) => s.leave);

	useEffect(() => {
		void join(projectId);
		return () => leave();
	}, [projectId, join, leave]);

	return (
		<div className="flex items-center gap-2">
			<PresenceIndicator />
			<TeamChatButton />
			<TeamChat />
			<CollaborationNotifications />
		</div>
	);
}
