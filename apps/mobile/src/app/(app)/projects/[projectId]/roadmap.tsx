import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { ConvertButton } from "../../../../features/ConvertButton";
import { featuresByPhase, type RoadmapFeature, readRoadmap } from "../../../../features/files";
import { JobBar } from "../../../../features/JobBar";
import { useFeature } from "../../../../features/useFeature";
import { describeError } from "../../../../i18n";
import { ErrorBanner, Loading, Section } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

export default function Roadmap() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const feature = useFeature("roadmap", projectId);
	const { data, error, loading, refreshing, reload } = feature;

	if (loading && !data) return <Loading />;
	const roadmap = readRoadmap(data?.files["roadmap.json"]?.content);
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
				hasContent={!!roadmap}
				onStart={() => feature.start(roadmap ? { refresh: true } : {})}
				onCancel={feature.cancel}
			/>
			{!roadmap ? (
				<Text style={{ color: theme.textMuted }}>{t("roadmap.empty")}</Text>
			) : (
				<>
					{roadmap.vision ? (
						<Section title={t("roadmap.vision")}>
							<Text style={{ color: theme.text, lineHeight: 22 }}>{roadmap.vision}</Text>
						</Section>
					) : null}
					{featuresByPhase(roadmap).map(({ phase, features }) => (
						<Section key={phase?.id ?? "other"} title={phase?.name || t("roadmap.otherPhase")}>
							{phase?.description ? <Text style={{ color: theme.textMuted }}>{phase.description}</Text> : null}
							{features.map((f) => (
								<FeatureRow key={f.id} projectId={projectId} feature={f} onConverted={reload} />
							))}
						</Section>
					))}
				</>
			)}
		</ScrollView>
	);
}

function FeatureRow({
	projectId,
	feature,
	onConverted,
}: {
	projectId: string;
	feature: RoadmapFeature;
	onConverted: () => Promise<void>;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [open, setOpen] = useState(false);
	const label = (group: string, value: string | null) =>
		value && i18n.exists(`roadmap.${group}.${value}`) ? t(`roadmap.${group}.${value}`) : value;
	const tags = [label("priority", feature.priority), label("status", feature.status)].filter(Boolean).join(" · ");
	return (
		<View style={[styles.feature, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			<Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}>
				<Text style={{ color: theme.text, fontWeight: "600" }}>{feature.title}</Text>
				{tags ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{tags}</Text> : null}
			</Pressable>
			{open ? (
				<>
					<Text style={{ color: theme.textMuted, lineHeight: 20 }}>{feature.description}</Text>
					<ConvertButton
						projectId={projectId}
						linkedCardId={feature.linkedCardId}
						convert={() => api.convertRoadmapFeature(projectId, feature.id)}
						onConverted={onConverted}
					/>
				</>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	feature: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
