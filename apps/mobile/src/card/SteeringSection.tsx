/**
 * Guide the card's agent while it works (`foundation/steering.py` on the
 * server): the message reaches the next session's prompt, and the card says
 * which session received it. Sending needs `agent.execute`; the server checks
 * it again.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import type { SteeringMessage } from "../api/types";
import { useApi } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field, Section } from "../ui/components";
import { formatDate } from "../ui/format";
import { SPACE, useTheme } from "../ui/theme";

/** The server's bound (`MAX_STEERING_CHARS`). */
export const MAX_STEERING_CHARS = 4000;
const POLL_MS = 10_000;

export function SteeringSection({
	projectId,
	cardId,
	canSend,
	working,
}: {
	projectId: string;
	cardId: string;
	canSend: boolean;
	working: boolean;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [messages, setMessages] = useState<SteeringMessage[]>([]);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setMessages(await api.steering(projectId, cardId));
		} catch {
			// The section stays as it was; the card's own errors are shown above.
		}
	}, [api, projectId, cardId]);

	useEffect(() => {
		void load();
		if (!working) return;
		const timer = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [load, working]);

	if (!canSend && messages.length === 0) return null;

	const send = async () => {
		setBusy(true);
		try {
			setMessages(await api.steer(projectId, cardId, text.trim()));
			setText("");
			setError(null);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section title={t("card.steeringTitle")}>
			{messages.map((m) => (
				<View key={m.id} style={styles.message}>
					<Text style={{ color: theme.text }}>{m.text}</Text>
					<Text style={{ color: theme.textMuted }}>
						{m.deliveredAt
							? t("card.steeringDelivered", {
									session: m.deliveredSession ?? "?",
									date: formatDate(m.deliveredAt, i18n.language),
								})
							: t("card.steeringQueued")}
					</Text>
				</View>
			))}
			{canSend ? (
				<>
					<Field
						label={t("card.steeringLabel")}
						value={text}
						onChangeText={setText}
						multiline
						maxLength={MAX_STEERING_CHARS}
					/>
					{error ? <ErrorBanner message={error} /> : null}
					<Button
						label={t("card.steeringSend")}
						busy={busy}
						disabled={busy || !text.trim()}
						onPress={() => void send()}
					/>
				</>
			) : null}
		</Section>
	);
}

const styles = StyleSheet.create({
	message: { gap: SPACE.xs, marginBottom: SPACE.sm },
});
