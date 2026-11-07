import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useApi, useSession } from "../../../../../auth/session";
import { JOB_POLL_MS } from "../../../../../features/useFeature";
import type { InsightMessage } from "../../../../../features/types";
import { useLoad } from "../../../../../hooks/useLoad";
import { describeError } from "../../../../../i18n";
import { Button, ErrorBanner, Loading } from "../../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../../ui/theme";

const MAX_MESSAGE = 20_000;

export default function Conversation() {
	const { projectId, sessionId } = useLocalSearchParams<{ projectId: string; sessionId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const router = useRouter();
	const load = useCallback(() => api.insightSession(projectId, sessionId), [api, projectId, sessionId]);
	const { data, error, loading, reload } = useLoad(load);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const answering = !!data?.jobId;

	// While an answer is written, read the conversation again until it lands.
	useEffect(() => {
		if (!answering) return;
		const timer = setInterval(() => void reload(), JOB_POLL_MS);
		return () => clearInterval(timer);
	}, [answering, reload]);

	if (loading && !data) return <Loading />;
	if (!data) return <ErrorBanner message={describeError(error)} />;

	const canAsk = data.mine && can("agent.execute");
	const send = async () => {
		setBusy(true);
		setActionError(null);
		try {
			await api.askInsight(projectId, sessionId, message.trim());
			setMessage("");
			await reload();
		} catch (err) {
			setActionError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = () =>
		Alert.alert(t("insights.deleteTitle"), t("insights.deleteBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("actions.delete"),
				style: "destructive",
				onPress: async () => {
					try {
						await api.deleteInsight(projectId, sessionId);
						router.back();
					} catch (err) {
						setActionError(describeError(err));
					}
				},
			},
		]);

	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Stack.Screen options={{ headerTitle: data.title }} />
			<ScrollView contentContainerStyle={styles.content}>
				<ErrorBanner message={actionError} />
				{data.messages.length === 0 ? <Text style={{ color: theme.textMuted }}>{t("insights.askFirst")}</Text> : null}
				{data.messages.map((m) => (
					<Bubble key={m.id} message={m} />
				))}
				{answering ? <Text style={{ color: theme.textMuted }}>{t("insights.answering")}</Text> : null}
				{data.mine && can("insight.write") ? (
					<Button label={t("insights.delete")} variant="danger" onPress={remove} />
				) : null}
			</ScrollView>
			{canAsk ? (
				<View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
					<TextInput
						accessibilityLabel={t("insights.question")}
						placeholder={t("insights.question")}
						placeholderTextColor={theme.textFaint}
						value={message}
						onChangeText={setMessage}
						maxLength={MAX_MESSAGE}
						multiline
						style={[styles.input, { color: theme.text, borderColor: theme.border }]}
					/>
					<Button
						label={t("card.send")}
						busy={busy}
						disabled={!message.trim() || answering}
						onPress={() => void send()}
					/>
				</View>
			) : null}
		</KeyboardAvoidingView>
	);
}

function Bubble({ message }: { message: InsightMessage }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const mine = message.role === "user";
	return (
		<View
			style={[
				styles.bubble,
				mine
					? { alignSelf: "flex-end", backgroundColor: theme.accentSoft }
					: { alignSelf: "flex-start", backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 },
			]}
		>
			<Text style={{ color: theme.text, lineHeight: 21 }} selectable>
				{message.content}
			</Text>
			{message.suggestedTask?.title ? (
				<Text style={{ color: theme.accent, fontSize: 12 }}>
					{t("insights.suggested", { title: message.suggestedTask.title })}
				</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl },
	bubble: { maxWidth: "88%", borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.xs },
	composer: { flexDirection: "row", alignItems: "flex-end", gap: SPACE.sm, padding: SPACE.sm, borderTopWidth: 1 },
	input: { flex: 1, maxHeight: 140, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm },
});
