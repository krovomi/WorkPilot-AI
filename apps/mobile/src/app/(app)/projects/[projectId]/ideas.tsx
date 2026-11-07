import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { ConvertButton } from "../../../../features/ConvertButton";
import { IDEA_TYPES, type Idea, readIdeas } from "../../../../features/files";
import { JobBar } from "../../../../features/JobBar";
import { useFeature } from "../../../../features/useFeature";
import { describeError } from "../../../../i18n";
import { ErrorBanner, Loading, Section } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Ideas() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const feature = useFeature("ideation", projectId);
	const { data, error, loading, refreshing, reload } = feature;
	const ideas = useMemo(
		() => readIdeas(data?.files["ideation.json"]?.content).filter((idea) => idea.status !== "dismissed"),
		[data],
	);

	if (loading && !data) return <Loading />;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={error ? describeError(error) : null} />
			<JobBar
				job={feature.job}
				active={feature.active}
				lastLine={feature.lastLine}
				hasContent={ideas.length > 0}
				onStart={() => feature.start(ideas.length ? { append: true } : {})}
				onCancel={feature.cancel}
			/>
			{ideas.length === 0 ? (
				<Text style={{ color: theme.textMuted }}>{t("ideas.empty")}</Text>
			) : (
				IDEA_TYPES.map((type) => {
					const ofType = ideas.filter((idea) => idea.type === type);
					if (!ofType.length) return null;
					return (
						<Section key={type} title={`${t(`ideas.types.${type}`)} (${ofType.length})`}>
							{ofType.map((idea) => (
								<IdeaRow key={idea.id} projectId={projectId} idea={idea} onConverted={reload} />
							))}
						</Section>
					);
				})
			)}
		</ScrollView>
	);
}

function IdeaRow({ projectId, idea, onConverted }: { projectId: string; idea: Idea; onConverted: () => Promise<void> }) {
	const theme = useTheme();
	const api = useApi();
	const [open, setOpen] = useState(false);
	return (
		<View style={[styles.idea, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			<Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}>
				<Text style={{ color: theme.text, fontWeight: "600" }}>{idea.title}</Text>
				{idea.level ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{idea.level}</Text> : null}
			</Pressable>
			{open ? (
				<>
					<Text style={{ color: theme.textMuted, lineHeight: 20 }}>{idea.description}</Text>
					{idea.rationale ? <Text style={{ color: theme.textFaint, lineHeight: 20 }}>{idea.rationale}</Text> : null}
					<ConvertButton
						projectId={projectId}
						linkedCardId={idea.linkedCardId}
						convert={() => api.convertIdea(projectId, idea.id)}
						onConverted={onConverted}
					/>
				</>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	idea: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
