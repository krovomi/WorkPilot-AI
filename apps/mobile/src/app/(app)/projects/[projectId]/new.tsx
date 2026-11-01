import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { CardKind } from "../../../../api/types";
import { useApi } from "../../../../auth/session";
import { describeError } from "../../../../i18n";
import { ChoiceChips } from "../../../../new-card/ChoiceChips";
import { type EngineChoice, type EngineOption, isModelValid, NO_CHOICE, settingsPayload } from "../../../../new-card/engine";
import { EngineSection } from "../../../../new-card/EngineSection";
import { attachmentsPayload, type PendingImage } from "../../../../new-card/images";
import { ImagesSection } from "../../../../new-card/ImagesSection";
import { MAX_DESCRIPTION, MAX_TITLE } from "../../../../new-card/limits";
import { takeShareDraft } from "../../../../new-card/share";
import { Button, ErrorBanner, Field } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

const KINDS: readonly (CardKind | null)[] = [null, "feature", "bug_fix", "refactoring", "investigation", "docs", "test"];

export default function NewCard() {
	const { projectId, shared } = useLocalSearchParams<{ projectId: string; shared?: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const router = useRouter();
	// Text shared from another app, read once: it only fills the form.
	const [draft] = useState(() => (shared === "1" ? takeShareDraft() : null));
	const [title, setTitle] = useState(draft?.title ?? "");
	const [description, setDescription] = useState(draft?.description ?? "");
	const [kind, setKind] = useState<CardKind | null>(null);
	const [requireReview, setRequireReview] = useState(true);
	const [engines, setEngines] = useState<EngineOption[]>([]);
	const [engine, setEngine] = useState<EngineChoice>(NO_CHOICE);
	const [images, setImages] = useState<PendingImage[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		// An older server lists no engine: the card then runs with the default.
		api.engines(projectId).then(
			(list) => live && setEngines(Array.isArray(list) ? list : []),
			() => live && setEngines([]),
		);
		return () => {
			live = false;
		};
	}, [api, projectId]);

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const card = await api.createCard(projectId, {
				title: title.trim(),
				description: description.trim(),
				kind,
				requireReview,
				settings: settingsPayload(engine, engines),
				attachments: attachmentsPayload(images),
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
				{draft ? (
					<Text accessibilityRole="alert" style={{ color: theme.textMuted }}>
						{t("newCard.fromShare")}
					</Text>
				) : null}
				<Field label={t("newCard.cardTitle")} value={title} onChangeText={setTitle} maxLength={MAX_TITLE} autoFocus={!draft} />
				<Field
					label={t("newCard.description")}
					placeholder={t("newCard.descriptionPlaceholder")}
					value={description}
					onChangeText={setDescription}
					maxLength={MAX_DESCRIPTION}
					multiline
					textAlignVertical="top"
				/>
				<Text style={{ color: theme.textFaint, fontSize: 12 }}>{t("newCard.dictationHint")}</Text>
				<ChoiceChips
					label={t("newCard.kind")}
					choices={KINDS.map((value) => ({ value, label: t(`kinds.${value ?? "none"}`) }))}
					selected={kind}
					onSelect={setKind}
				/>
				<EngineSection engines={engines} choice={engine} onChange={setEngine} />
				<ImagesSection images={images} onChange={setImages} />
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
				<Button label={t("newCard.create")} busy={busy} disabled={!title.trim() || !isModelValid(engine.model)} onPress={() => void create()} />
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg },
	review: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderWidth: 1,
		borderRadius: RADIUS.lg,
		padding: SPACE.lg,
	},
});
