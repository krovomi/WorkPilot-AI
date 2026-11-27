/**
 * The team chat of a project: who is on the project now, the conversation
 * the server keeps (its last 100 messages on arrival, then each new one
 * live), answering a message, and writing one. A viewer reads it; the
 * server refuses their messages, so the phone does not offer to write.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useUserId } from "../../../../auth/session";
import { useProject } from "../../../../forge/useForge";
import { ErrorBanner, KeyboardAvoiding, Loading } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { press } from "../../../../ui/haptics";
import { Icon } from "../../../../ui/Icon";
import { Avatar, EmptyState, IconButton } from "../../../../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../../../../ui/theme";
import { CHAT_MAX, type ChatMessage } from "../../../../team/room";
import { useTeamRoom } from "../../../../team/useTeamRoom";

export default function TeamChat() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const userId = useUserId();
	const project = useProject(projectId).data;
	const room = useTeamRoom(projectId);
	const [draft, setDraft] = useState("");
	const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
	const lastSent = useRef<string | null>(null);
	const list = useRef<FlatList<ChatMessage>>(null);
	const forbidden = room.rejected?.reason === "forbidden";
	const canWrite = project?.my_role !== "viewer" && !forbidden;

	// A refused message comes back to the field, unless something else was typed since.
	useEffect(() => {
		if (!room.rejected || !lastSent.current) return;
		const text = lastSent.current;
		lastSent.current = null;
		setDraft((current) => current || text);
	}, [room.rejected]);

	const send = () => {
		const text = draft.trim();
		if (!room.send(text, replyTo?.id)) return;
		press();
		lastSent.current = text;
		setDraft("");
		setReplyTo(null);
	};

	const byId = new Map(room.messages.map((m) => [m.id, m]));
	const rejection = room.rejected && !forbidden ? t(`chat.rejected.${room.rejected.reason}`) : null;

	return (
		<KeyboardAvoiding>
			<Stack.Screen options={{ headerTitle: t("chat.title") }} />
			<View style={[styles.presence, { borderColor: theme.border, backgroundColor: theme.surface }]}>
				<View style={[styles.dot, { backgroundColor: room.live ? theme.success : theme.textFaint }]} />
				{room.live ? (
					<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.people}>
						<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "600" }]}>
							{t("chat.here", { count: room.members.length })}
						</Text>
						{room.members.map((member) => (
							<View key={member.id} style={styles.person}>
								<Avatar name={member.name} size={22} />
								<Text style={[TYPE.small, { color: theme.text }]} numberOfLines={1}>
									{member.id === userId ? t("chat.you") : member.name}
								</Text>
							</View>
						))}
					</ScrollView>
				) : (
					<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "600" }]}>{t("chat.connecting")}</Text>
				)}
			</View>
			{room.ready ? (
				<FlatList<ChatMessage>
					ref={list}
					data={room.messages}
					keyExtractor={(m) => m.id}
					contentContainerStyle={styles.content}
					onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
					ListEmptyComponent={<EmptyState icon="message-square" title={t("chat.empty")} hint={t("chat.emptyHint")} />}
					renderItem={({ item }) => (
						<Bubble
							message={item}
							mine={item.authorId === userId}
							parent={item.replyTo ? byId.get(item.replyTo) : undefined}
							onReply={canWrite ? () => setReplyTo(item) : undefined}
						/>
					)}
				/>
			) : (
				<Loading />
			)}
			{canWrite ? (
				<View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
					<ErrorBanner message={rejection} />
					{replyTo ? (
						<View style={[styles.replying, { backgroundColor: theme.elevated }]}>
							<Icon name="corner-up-left" size={14} color={theme.textMuted} />
							<Text style={[TYPE.small, { color: theme.textMuted, flex: 1 }]} numberOfLines={1}>
								{t("chat.replyingTo", { name: replyTo.author, message: replyTo.message })}
							</Text>
							<IconButton icon="x" label={t("chat.cancelReply")} onPress={() => setReplyTo(null)} />
						</View>
					) : null}
					<View style={styles.row}>
						<TextInput
							accessibilityLabel={t("chat.message")}
							placeholder={t("chat.message")}
							placeholderTextColor={theme.textFaint}
							value={draft}
							onChangeText={setDraft}
							maxLength={CHAT_MAX}
							multiline
							style={[styles.input, { color: theme.text, borderColor: theme.border }]}
						/>
						<IconButton
							icon="send"
							label={t("chat.send")}
							color={theme.accent}
							disabled={!room.live || !draft.trim()}
							onPress={send}
						/>
					</View>
				</View>
			) : (
				<Text style={[TYPE.small, styles.readOnly, { color: theme.textMuted, borderColor: theme.border }]}>
					{t("chat.readOnly")}
				</Text>
			)}
		</KeyboardAvoiding>
	);
}

function Bubble({
	message,
	mine,
	parent,
	onReply,
}: {
	message: ChatMessage;
	mine: boolean;
	parent: ChatMessage | undefined;
	onReply?: () => void;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	return (
		<View style={[styles.message, { alignSelf: mine ? "flex-end" : "flex-start" }]}>
			{mine ? null : (
				<View style={styles.author}>
					<Avatar name={message.author} size={20} />
					<Text style={[TYPE.caption, { color: theme.textMuted, fontWeight: "700" }]}>{message.author}</Text>
				</View>
			)}
			<View
				style={[
					styles.bubble,
					mine
						? { backgroundColor: theme.accentSoft }
						: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 },
				]}
			>
				{parent ? (
					<Text style={[TYPE.small, styles.quote, { color: theme.textMuted, borderColor: theme.border }]} numberOfLines={2}>
						{t("chat.inReplyTo", { name: parent.author, message: parent.message })}
					</Text>
				) : null}
				<Text style={[TYPE.body, { color: theme.text }]} selectable>
					{message.message}
				</Text>
			</View>
			<View style={[styles.meta, { justifyContent: mine ? "flex-end" : "flex-start" }]}>
				<Text style={[TYPE.caption, { color: theme.textFaint }]}>{formatDate(message.at, i18n.language)}</Text>
				{onReply ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={t("chat.replyTo", { name: message.author })}
						hitSlop={8}
						onPress={onReply}
					>
						<Text style={[TYPE.caption, { color: theme.accent, fontWeight: "600" }]}>{t("chat.reply")}</Text>
					</Pressable>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	presence: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.sm,
		paddingHorizontal: SPACE.lg,
		paddingVertical: SPACE.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	people: { alignItems: "center", gap: SPACE.md },
	person: { flexDirection: "row", alignItems: "center", gap: SPACE.xs },
	content: { padding: SPACE.lg, gap: SPACE.md, flexGrow: 1 },
	message: { maxWidth: "88%", gap: SPACE.xs },
	author: { flexDirection: "row", alignItems: "center", gap: SPACE.xs },
	bubble: { borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.xs },
	quote: { borderLeftWidth: 3, paddingLeft: SPACE.sm },
	meta: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
	composer: { gap: SPACE.sm, padding: SPACE.sm, borderTopWidth: StyleSheet.hairlineWidth },
	replying: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, borderRadius: RADIUS.md, paddingLeft: SPACE.sm },
	row: { flexDirection: "row", alignItems: "flex-end", gap: SPACE.sm },
	input: { flex: 1, maxHeight: 140, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm },
	readOnly: { padding: SPACE.lg, borderTopWidth: StyleSheet.hairlineWidth, textAlign: "center" },
});
