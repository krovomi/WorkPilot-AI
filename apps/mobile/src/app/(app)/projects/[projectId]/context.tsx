import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { INDEX_FILE, readIndex } from "../../../../context/index-file";
import { MemoriesTab, TrashTab } from "../../../../context/MemoryViews";
import { JobBar } from "../../../../features/JobBar";
import { useFeature } from "../../../../features/useFeature";
import { ErrorBanner, Loading, Section } from "../../../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

type Tab = "index" | "memories" | "trash";

export default function Context() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const [tab, setTab] = useState<Tab>("index");
	return (
		<View style={{ flex: 1 }}>
			<View style={[styles.tabs, { borderColor: theme.border }]} accessibilityRole="tablist">
				{(["index", "memories", "trash"] as const).map((key) => {
					const selected = key === tab;
					return (
						<Pressable
							key={key}
							accessibilityRole="tab"
							aria-selected={selected}
							onPress={() => setTab(key)}
							style={[styles.tab, { borderColor: selected ? theme.accent : "transparent" }]}
						>
							<Text style={{ color: selected ? theme.accent : theme.textMuted, fontWeight: "600" }}>
								{t(`context.${key}`)}
							</Text>
						</Pressable>
					);
				})}
			</View>
			{tab === "index" ? <IndexTab projectId={projectId} /> : null}
			{tab === "memories" ? <MemoriesTab projectId={projectId} /> : null}
			{tab === "trash" ? <TrashTab projectId={projectId} /> : null}
		</View>
	);
}

function IndexTab({ projectId }: { projectId: string }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const feature = useFeature("context", projectId);
	const { data, error, loading, refreshing, reload } = feature;
	if (loading && !data) return <Loading />;
	const index = readIndex(data?.files[INDEX_FILE]?.content);
	const fact = (group: string, key: string) =>
		i18n.exists(`context.${group}.${key}`) ? t(`context.${group}.${key}`) : key;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner error={error} />
			<JobBar
				job={feature.job}
				active={feature.active}
				lastLine={feature.lastLine}
				hasContent={!!index}
				onStart={() => feature.start()}
				onCancel={feature.cancel}
			/>
			{!index ? (
				<Text style={{ color: theme.textMuted }}>{t("context.noIndex")}</Text>
			) : (
				<>
					{index.projectType ? (
						<Text style={{ color: theme.textMuted }}>
							{t("context.projectType", { type: fact("type", index.projectType) })}
						</Text>
					) : null}
					<Section title={t("context.services", { count: index.services.length })}>
						{index.services.map((s) => (
							<View key={s.name} style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
								<Text style={{ color: theme.text, fontWeight: "600" }}>{s.name}</Text>
								{s.path ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{s.path}</Text> : null}
								{s.labels.length || s.port ? (
									<Text style={{ color: theme.textMuted }}>
										{[...s.labels, s.port ? t("context.port", { port: s.port }) : null].filter(Boolean).join(" · ")}
									</Text>
								) : null}
							</View>
						))}
					</Section>
					{(
						[
							["infrastructure", index.infrastructure],
							["conventions", index.conventions],
						] as const
					).map(([group, rows]) =>
						rows.length ? (
							<Section key={group} title={t(`context.${group}`)}>
								{rows.map((row) => (
									<View key={row.key} style={styles.fact}>
										<Text style={{ color: theme.textMuted, flex: 1 }}>{fact(`${group}Keys`, row.key)}</Text>
										<Text style={{ color: theme.text, flex: 1, textAlign: "right" }}>{row.value}</Text>
									</View>
								))}
							</Section>
						) : null,
					)}
				</>
			)}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
	tab: { flex: 1, alignItems: "center", paddingVertical: SPACE.md, borderBottomWidth: 2 },
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	fact: { flexDirection: "row", gap: SPACE.md },
});
