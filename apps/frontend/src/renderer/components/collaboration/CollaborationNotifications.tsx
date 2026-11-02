/**
 * Toasts for what teammates did on the shown server project (server mode):
 * someone arrived or left, claimed or released a card, a run of theirs ended,
 * a message mentions me, or the server did not take my message. Each kind
 * can be turned off in the collaboration settings.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../hooks/use-toast";
import {
	type CollaborationNotice,
	type CollaborationSettings,
	useCollaborationStore,
} from "../../stores/collaboration-store";

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface Toast {
	title: string;
	description?: string;
	variant?: "default" | "destructive";
}

/** The toast of a notice, or null when the settings turn it off. */
export function toastOf(
	notice: CollaborationNotice,
	settings: CollaborationSettings,
	t: Translate,
): Toast | null {
	if (notice.kind === "mention") {
		if (!settings.notifyChatMentions) return null;
		return { title: t("notifications.mentionedYou", { user: notice.author }), description: notice.message };
	}
	if (notice.kind === "rejected") {
		// The chat panel says it too; a toast when the panel is closed.
		return { title: t(`chat.errors.${notice.reason}`), variant: "destructive" };
	}
	const a = notice.activity;
	switch (a.type) {
		case "joined":
		case "left":
			return settings.notifyUserJoinLeave
				? { title: t(a.type === "joined" ? "notifications.userJoined" : "notifications.userLeft", { user: a.user }) }
				: null;
		case "claimed":
		case "released":
			return settings.notifyTaskLocks
				? {
						title: t(a.type === "claimed" ? "notifications.taskClaimed" : "notifications.taskReleased", {
							user: a.user,
							task: a.card,
						}),
					}
				: null;
		case "run_finished":
			if (!settings.notifyAgentActivity) return null;
			return {
				title: t(`notifications.run.${a.status}`, { user: a.user, task: a.card }),
				description: a.phase ? t("notifications.run.phase", { phase: a.phase }) : undefined,
				variant: a.status === "failed" ? "destructive" : "default",
			};
	}
}

export function CollaborationNotifications() {
	const { t } = useTranslation("collaboration");
	const notices = useCollaborationStore((s) => s.notices);
	const settings = useCollaborationStore((s) => s.settings);
	const chatOpen = useCollaborationStore((s) => s.chatOpen);
	const takeNotices = useCollaborationStore((s) => s.takeNotices);

	useEffect(() => {
		if (notices.length === 0) return;
		for (const notice of takeNotices()) {
			if (notice.kind === "rejected" && chatOpen) continue;
			const shown = toastOf(notice, settings, t);
			if (shown) toast(shown);
		}
	}, [notices, settings, chatOpen, takeNotices, t]);

	return null;
}
