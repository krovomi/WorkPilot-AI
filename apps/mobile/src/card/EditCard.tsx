/**
 * Edit a card's title and description, as on the desktop, until work starts:
 * the server refuses (409) once a spec or a build workspace exists, because
 * they were written from this text.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import type { CardDetails } from "../api/types";
import { useApi } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field, Section } from "../ui/components";
import { SPACE } from "../ui/theme";

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 20_000;

/** Whether the card may still be edited: nothing was written from its text yet. */
export function canEditCard(details: Pick<CardDetails, "spec" | "column">, working: boolean): boolean {
	return !details.spec && !working && (details.column === "backlog" || details.column === "queue");
}

export function EditCard({
	projectId,
	details,
	onCancel,
	onSaved,
}: {
	projectId: string;
	details: CardDetails;
	onCancel: () => void;
	onSaved: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const api = useApi();
	const [title, setTitle] = useState(details.title);
	const [description, setDescription] = useState(details.description);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const unchanged = title.trim() === details.title && description === details.description;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.updateCard(projectId, details.id, {
				...(title.trim() !== details.title ? { title: title.trim() } : {}),
				...(description !== details.description ? { description } : {}),
			});
			await onSaved();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section title={t("card.editTitle")}>
			<ErrorBanner message={error} />
			<Field label={t("newCard.cardTitle")} value={title} onChangeText={setTitle} maxLength={MAX_TITLE} />
			<Field
				label={t("newCard.description")}
				value={description}
				onChangeText={setDescription}
				maxLength={MAX_DESCRIPTION}
				multiline
			/>
			<View style={styles.inline}>
				<Button label={t("common.cancel")} variant="secondary" onPress={onCancel} style={{ flex: 1 }} />
				<Button
					label={t("card.save")}
					busy={busy}
					disabled={!title.trim() || unchanged}
					onPress={() => void save()}
					style={{ flex: 1 }}
				/>
			</View>
		</Section>
	);
}

const styles = StyleSheet.create({ inline: { flexDirection: "row", gap: SPACE.sm } });
