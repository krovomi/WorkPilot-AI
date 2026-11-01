import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { CardKind } from "../../../../api/types";
import { useApi } from "../../../../auth/session";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Field } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

const KINDS: readonly (CardKind | null)[] = [null, "feature", "bug_fix", "refactoring", "investigation", "docs", "test"];
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

export default function NewCard() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const router = useRouter();
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [kind, setKind] = useState<CardKind | null>(null);
	const [requireReview, setRequireReview] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const card = await api.createCard(projectId, {
				title: title.trim(),
				description: description.trim(),
				kind,
				requireReview,
			});
			router.replace({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId, cardId: card.id } });
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				<Field label={t("newCard.cardTitle")} value={title} onChangeText={setTitle} maxLength={MAX_TITLE} autoFocus />
				<Field
					label={t("newCard.description")}
					placeholder={t("newCard.descriptionPlaceholder")}
					value={description}
					onChangeText={setDescription}
					maxLength={MAX_DESCRIPTION}
					multiline
				/>
				<View style={{ gap: SPACE.sm }}>
					<Text style={{ color: theme.textMuted, fontSize: 13, fontWeight: "500" }}>{t("newCard.kind")}</Text>
					<View style={styles.kinds}>
						{KINDS.map((value) => {
							const selected = value === kind;
							return (
								<Pressable
									key={value ?? "none"}
									accessibilityRole="radio"
									accessibilityState={{ selected }}
									onPress={() => setKind(value)}
									style={[
										styles.kind,
										{
											borderColor: selected ? theme.accent : theme.border,
											backgroundColor: selected ? theme.accentSoft : theme.surface,
										},
									]}
								>
									<Text style={{ color: theme.text }}>{t(`kinds.${value ?? "none"}`)}</Text>
								</Pressable>
							);
						})}
					</View>
				</View>
				<View style={[styles.review, { borderColor: theme.border, backgroundColor: theme.surface }]}>
					<View style={{ flex: 1, gap: 2 }}>
						<Text style={{ color: theme.text, fontWeight: "600" }}>{t("newCard.requireReview")}</Text>
						<Text style={{ color: theme.textMuted, fontSize: 13 }}>{t("newCard.requireReviewHint")}</Text>
					</View>
					<Switch
						accessibilityLabel={t("newCard.requireReview")}
						value={requireReview}
						onValueChange={setRequireReview}
						trackColor={{ true: theme.accent, false: theme.elevated }}
					/>
				</View>
				<ErrorBanner message={error} />
				<Button label={t("newCard.create")} busy={busy} disabled={!title.trim()} onPress={() => void create()} />
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg },
	kinds: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
	kind: { borderWidth: 1, borderRadius: 999, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
	review: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderWidth: 1,
		borderRadius: RADIUS.lg,
		padding: SPACE.lg,
	},
});
