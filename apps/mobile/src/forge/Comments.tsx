/** A forge thread's comments, and a box to add one as the person (their token, on the server). */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field, Section } from "../ui/components";
import { formatDate } from "../ui/format";
import { RADIUS, SPACE, useTheme } from "../ui/theme";
import type { ForgeComment } from "./types";

export function Comments({
	comments,
	canComment,
	onSend,
}: {
	comments: ForgeComment[];
	canComment: boolean;
	onSend: (body: string) => Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { can } = useSession();
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = async () => {
		setBusy(true);
		setError(null);
		try {
			await onSend(body.trim());
			setBody("");
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section title={t("forge.comments", { count: comments.length })}>
			{comments.map((c) => (
				<View key={c.id} style={[styles.comment, { borderColor: theme.border }]}>
					<Text style={{ color: theme.textFaint, fontSize: 12 }}>
						{[c.author, formatDate(c.createdAt, i18n.language)].filter(Boolean).join(" · ")}
					</Text>
					<Text style={{ color: theme.text, lineHeight: 21 }} selectable>
						{c.body}
					</Text>
				</View>
			))}
			{canComment && can("vcs.write") ? (
				<>
					<ErrorBanner message={error} />
					<Field label={t("forge.newComment")} value={body} onChangeText={setBody} multiline maxLength={60_000} />
					<Button label={t("forge.comment")} busy={busy} disabled={!body.trim()} onPress={() => void send()} />
				</>
			) : null}
		</Section>
	);
}

const styles = StyleSheet.create({
	comment: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: SPACE.xs, borderRadius: RADIUS.sm },
});
