/**
 * The team chat of the shown server project (server mode): a button in the
 * board's toolbar with the unread count, and the panel it opens. Messages go
 * through the project's stream; the server stores them, so a teammate who
 * arrives later reads the latest ones. A message is shown as text.
 */

import { MessageCircle, Reply, Search, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TEAM_CHAT_MAX, type TeamChatMessage } from "../../../shared/types";
import { cn } from "../../lib/utils";
import { avatarColor, useCollaborationStore } from "../../stores/collaboration-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { initialsOf } from "./PresenceIndicator";

const SEND_ERRORS = new Set(["forbidden", "invalid", "too_fast", "unavailable", "offline"]);

function formatTime(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubble({
	message,
	parent,
	isOwn,
	onReply,
}: {
	message: TeamChatMessage;
	parent: TeamChatMessage | undefined;
	isOwn: boolean;
	onReply: (message: TeamChatMessage) => void;
}) {
	const { t } = useTranslation("collaboration");
	return (
		<div className={cn("group flex gap-2", isOwn ? "flex-row-reverse" : "flex-row")}>
			<span
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
				style={{ backgroundColor: avatarColor(message.authorId || message.author) }}
			>
				{initialsOf(message.author)}
			</span>
			<div className={cn("flex max-w-[75%] flex-col gap-0.5", isOwn ? "items-end" : "items-start")}>
				<div className="flex items-center gap-1.5">
					<span className="text-xs font-medium">{message.author}</span>
					<span className="text-[10px] text-muted-foreground">{formatTime(message.at)}</span>
				</div>
				{parent && (
					<span className="max-w-full truncate border-l-2 pl-1.5 text-[11px] text-muted-foreground">
						{t("chat.inReplyTo", { user: parent.author })}: {parent.message}
					</span>
				)}
				<div
					className={cn(
						"whitespace-pre-wrap wrap-break-word rounded-lg px-3 py-1.5 text-sm",
						isOwn ? "bg-primary text-primary-foreground" : "bg-muted",
					)}
				>
					{message.message}
				</div>
				<button
					type="button"
					onClick={() => onReply(message)}
					className="hidden items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground group-hover:inline-flex"
				>
					<Reply className="h-3 w-3" />
					{t("chat.reply")}
				</button>
			</div>
		</div>
	);
}

/** The toolbar button that opens the chat, with the unread count. */
export function TeamChatButton() {
	const { t } = useTranslation("collaboration");
	const enabled = useCollaborationStore((s) => s.settings.chatEnabled);
	const unread = useCollaborationStore((s) => s.unreadChatCount);
	const toggleChat = useCollaborationStore((s) => s.toggleChat);
	if (!enabled) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			className="relative h-8 gap-1.5"
			onClick={toggleChat}
			aria-label={t("chat.title")}
		>
			<MessageCircle className="h-4 w-4" />
			<span className="hidden lg:inline">{t("chat.title")}</span>
			{unread > 0 && (
				<span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
					{unread > 99 ? "99+" : unread}
				</span>
			)}
		</Button>
	);
}

export function TeamChat() {
	const { t } = useTranslation("collaboration");
	const chatOpen = useCollaborationStore((s) => s.chatOpen);
	const enabled = useCollaborationStore((s) => s.settings.chatEnabled);
	const messages = useCollaborationStore((s) => s.messages);
	const me = useCollaborationStore((s) => s.me);
	const live = useCollaborationStore((s) => s.live);
	const replyingTo = useCollaborationStore((s) => s.replyingTo);
	const sendError = useCollaborationStore((s) => s.sendError);
	const sendMessage = useCollaborationStore((s) => s.sendMessage);
	const setReplyingTo = useCollaborationStore((s) => s.setReplyingTo);
	const setChatOpen = useCollaborationStore((s) => s.setChatOpen);

	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const endRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Down to the latest message when the panel opens and when one arrives.
	const count = messages.length;
	useEffect(() => {
		if (chatOpen && count > 0) endRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [count, chatOpen]);

	useEffect(() => {
		if (chatOpen) inputRef.current?.focus();
	}, [chatOpen]);

	if (!enabled || !chatOpen) return null;

	const byId = new Map(messages.map((m) => [m.id, m]));
	const needle = query.trim().toLowerCase();
	const shown = needle
		? messages.filter(
				(m) => m.message.toLowerCase().includes(needle) || m.author.toLowerCase().includes(needle),
			)
		: messages;

	const send = async () => {
		if (!draft.trim()) return;
		if (await sendMessage(draft)) setDraft("");
	};

	return (
		<section
			className="fixed bottom-4 right-4 z-50 flex h-[28rem] w-80 flex-col rounded-xl border bg-background shadow-2xl"
			aria-label={t("chat.title")}
		>
			<header className="flex items-center justify-between border-b px-3 py-2">
				<h3 className="text-sm font-semibold">{t("chat.title")}</h3>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setSearching(!searching)}
						className="rounded p-1 hover:bg-accent"
						aria-label={t("chat.searchMessages")}
					>
						<Search className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={() => setChatOpen(false)}
						className="rounded p-1 hover:bg-accent"
						aria-label={t("chat.close")}
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</header>

			{searching && (
				<div className="border-b px-3 py-2">
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("chat.searchMessages")}
						className="h-7 text-xs"
					/>
				</div>
			)}

			<div className="flex-1 space-y-3 overflow-y-auto px-3 py-2">
				{shown.length === 0 ? (
					<p className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
						{needle ? t("chat.searchNoResults") : t("chat.noMessages")}
					</p>
				) : (
					shown.map((m) => (
						<MessageBubble
							key={m.id}
							message={m}
							parent={m.replyTo ? byId.get(m.replyTo) : undefined}
							isOwn={m.authorId === me?.id}
							onReply={setReplyingTo}
						/>
					))
				)}
				<div ref={endRef} />
			</div>

			{replyingTo && (
				<div className="flex items-center gap-2 border-t bg-muted/50 px-3 py-1.5">
					<Reply className="h-3 w-3 text-muted-foreground" />
					<span className="flex-1 truncate text-xs text-muted-foreground">
						{t("chat.replyTo", { user: replyingTo.author })}
					</span>
					<button
						type="button"
						onClick={() => setReplyingTo(null)}
						className="text-muted-foreground hover:text-foreground"
						aria-label={t("chat.cancelReply")}
					>
						<X className="h-3 w-3" />
					</button>
				</div>
			)}

			{sendError && SEND_ERRORS.has(sendError) && (
				<p className="border-t px-3 py-1 text-xs text-destructive" role="alert">
					{t(`chat.errors.${sendError}`)}
				</p>
			)}

			<div className="flex items-center gap-2 border-t px-3 py-2">
				<Input
					ref={inputRef}
					value={draft}
					maxLength={TEAM_CHAT_MAX}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={live ? t("chat.placeholder") : t("presence.reconnecting")}
					disabled={!live}
					className="h-8 text-sm"
				/>
				<Button
					size="sm"
					className="h-8 w-8 shrink-0 p-0"
					onClick={() => void send()}
					disabled={!live || !draft.trim()}
					aria-label={t("chat.send")}
				>
					<Send className="h-3.5 w-3.5" />
				</Button>
			</div>
		</section>
	);
}
