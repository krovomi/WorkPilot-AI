import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { INDEX_FILE, readIndex } from "../../../../context/index-file";
import { JobBar } from "../../../../features/JobBar";
import { useFeature } from "../../../../features/useFeature";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { ErrorBanner, Field, Loading, Section } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

type Tab = "index" | "memories";

export default function Context() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const [tab, setTab] = useState<Tab>("index");
	return (
		<View style={{ flex: 1 }}>
			<View style={[styles.tabs, { borderColor: theme.border }]} accessibilityRole="tablist">
				{(["index", "memories"] as const).map((key) => {
					const selected = key === tab;
					return (
						<Pressable
							key={key}
							accessibilityRole="tab"
							accessibilityState={{ selected }}
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
			{tab === "index" ? <IndexTab projectId={projectId} /> : <MemoriesTab projectId={projectId} />}
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
			<ErrorBanner message={error ? describeError(error) : null} />
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

/** The brain's memories, the latest first, or ranked against what the person searches. */
function MemoriesTab({ projectId }: { projectId: string }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [typed, setTyped] = useState("");
	const [query, setQuery] = useState("");
	// Search once the person pauses typing, not at each letter.
	useEffect(() => {
		const timer = setTimeout(() => setQuery(typed.trim()), 400);
		return () => clearTimeout(timer);
	}, [typed]);
	const load = useCallback(() => api.memories(projectId, query), [api, projectId, query]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Field
				label={t("context.search")}
				value={typed}
				onChangeText={setTyped}
				maxLength={500}
				autoCapitalize="none"
				returnKeyType="search"
			/>
			<ErrorBanner message={error ? describeError(error) : null} />
			{loading && !data ? (
				<Loading />
			) : !data?.available ? (
				<Text style={{ color: theme.textMuted }}>{t("context.noBrain")}</Text>
			) : !data.memories.length ? (
				<Text style={{ color: theme.textMuted }}>{query ? t("context.noMatch") : t("context.noMemories")}</Text>
			) : (
				data.memories.map((m) => (
					<View key={m.id} style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<Text style={{ color: theme.textFaint, fontSize: 12 }}>
							{[
								i18n.exists(`context.memoryType.${m.type}`) ? t(`context.memoryType.${m.type}`) : m.type,
								m.timestamp ? formatDate(m.timestamp, i18n.language) : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
						<Text style={{ color: theme.text, lineHeight: 21 }} selectable numberOfLines={12}>
							{m.content}
						</Text>
					</View>
				))
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
