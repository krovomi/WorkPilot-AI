/**
 * The discussion under a bookmark (#347): each reader of a saved session
 * answers its note. Replies live in the session, so they leave with an export
 * or a team link and come back with an import; each is Markdown, shown as
 * text.
 */

import { MessageSquare, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ReplayBookmark } from "../../../shared/types/replay-share";
import { useReplayShareStore } from "../../stores/replay-share-store";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const MAX_NOTE = 4000;

export const ReplayBookmarkReplies: React.FC<{
	sessionId: string;
	bookmark: ReplayBookmark;
	/** A session still recording takes no reply. */
	readOnly: boolean;
}> = ({ sessionId, bookmark, readOnly }) => {
	const { t } = useTranslation(["replay"]);
	const [writing, setWriting] = useState(false);
	const [note, setNote] = useState("");
	const { savingBookmark, addReply, removeReply } = useReplayShareStore(
		useShallow((s) => ({
			savingBookmark: s.savingBookmark,
			addReply: s.addReply,
			removeReply: s.removeReply,
		})),
	);
	const replies = bookmark.replies ?? [];

	const send = async () => {
		const saved = await addReply(sessionId, bookmark.id, { note: note.trim() });
		if (saved) {
			setNote("");
			setWriting(false);
		}
	};

	return (
		<div className="mt-1 space-y-1">
			{replies.length > 0 && (
				<ul
					className="space-y-1 border-l border-[var(--wp-border)] pl-2"
					aria-label={t("replay:bookmarks.replies")}
				>
					{replies.map((reply) => (
						<li key={reply.id} className="text-sm">
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs text-muted-foreground">
									{reply.author || t("replay:bookmarks.someone")}
								</span>
								{!readOnly && (
									<Button
										variant="ghost"
										size="sm"
										aria-label={t("replay:bookmarks.removeReply")}
										onClick={() => removeReply(sessionId, bookmark.id, reply.id)}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								)}
							</div>
							<p className="whitespace-pre-wrap break-words">{reply.note}</p>
						</li>
					))}
				</ul>
			)}
			{!readOnly &&
				(writing ? (
					<div className="space-y-1">
						<Textarea
							value={note}
							maxLength={MAX_NOTE}
							onChange={(e) => setNote(e.target.value)}
							aria-label={t("replay:bookmarks.reply")}
							rows={2}
						/>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" size="sm" onClick={() => setWriting(false)}>
								{t("replay:bookmarks.cancelReply")}
							</Button>
							<Button
								size="sm"
								disabled={savingBookmark || !note.trim()}
								onClick={send}
							>
								{t("replay:bookmarks.sendReply")}
							</Button>
						</div>
					</div>
				) : (
					<Button
						variant="ghost"
						size="sm"
						className="px-0"
						onClick={() => setWriting(true)}
					>
						<MessageSquare className="h-3 w-3 mr-1" />
						{t("replay:bookmarks.reply")}
					</Button>
				))}
		</div>
	);
};
