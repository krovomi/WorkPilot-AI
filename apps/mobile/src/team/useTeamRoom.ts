/**
 * The team room of a project on screen: who is here, the conversation, and
 * sending to it. The messages live in memory only, as long as the screen;
 * the server keeps the conversation and sends its latest messages each time
 * the stream opens.
 */

import { useCallback, useState } from "react";
import { useAppActive } from "../project/useAppActive";
import { useProjectSocket } from "../project/useProjectSocket";
import { CHAT_MAX, type ChatMessage, type ChatRejection, type Member, readRoomEvent, withMessage } from "./room";

export interface TeamRoom {
	live: boolean;
	/** The history arrived: the conversation shown is the server's. */
	ready: boolean;
	members: Member[];
	messages: ChatMessage[];
	/** The last refusal of one of our messages, numbered so that the same one twice is seen twice. */
	rejected: { reason: ChatRejection; count: number } | null;
	send(text: string, replyTo?: string | null): boolean;
}

export function useTeamRoom(projectId: string): TeamRoom {
	const active = useAppActive();
	const [members, setMembers] = useState<Member[]>([]);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [ready, setReady] = useState(false);
	const [rejected, setRejected] = useState<TeamRoom["rejected"]>(null);
	const socket = useProjectSocket(projectId, active, {
		onEvent: (event) => {
			const room = readRoomEvent(event);
			if (!room) return;
			switch (room.kind) {
				case "presence":
					setMembers(room.members);
					break;
				case "history":
					setMessages(room.messages);
					setReady(true);
					break;
				case "message":
					setMessages((current) => withMessage(current, room.message));
					break;
				case "rejected":
					setRejected((current) => ({ reason: room.reason, count: (current?.count ?? 0) + 1 }));
					break;
			}
		},
	});
	const { send: sendRaw } = socket;
	const send = useCallback(
		(text: string, replyTo?: string | null) => {
			const message = text.trim();
			if (!message || message.length > CHAT_MAX) return false;
			return sendRaw({ type: "chat_message", message, ...(replyTo ? { reply_to: replyTo } : {}) });
		},
		[sendRaw],
	);
	return { live: socket.live, ready, members, messages, rejected, send };
}
