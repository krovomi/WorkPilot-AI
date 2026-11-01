import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { Forge } from "../../../../../forge/forge";
import type { ForgeIssue, ForgePull } from "../../../../../forge/types";
import { useForge } from "../../../../../forge/useForge";
import { useLoad } from "../../../../../hooks/useLoad";
import { describeError } from "../../../../../i18n";
import { ErrorBanner, Loading } from "../../../../../ui/components";
import { formatDate } from "../../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../../ui/theme";

type Tab = "issues" | "pulls";

export default function ForgeScreen() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const { forge, loading, error } = useForge(projectId);
	const [tab, setTab] = useState<Tab>("pulls");
	if (loading) return <Loading />;
	if (!forge) return <ErrorBanner message={error ? describeError(error) : t("forge.none")} />;
	return (
		<View style={{ flex: 1 }}>
			<Stack.Screen options={{ title: t(`forge.${forge.kind}`) }} />
			<Tabs forge={forge} tab={tab} onTab={setTab} />
			<ForgeList key={tab} forge={forge} projectId={projectId} tab={tab} />
		</View>
	);
}

function Tabs({ forge, tab, onTab }: { forge: Forge; tab: Tab; onTab: (tab: Tab) => void }) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View style={styles.tabs} accessibilityRole="tablist">
			{(["pulls", "issues"] as const).map((key) => {
				const selected = key === tab;
				return (
					<Pressable
						key={key}
						accessibilityRole="tab"
						accessibilityState={{ selected }}
						onPress={() => onTab(key)}
						style={[
							styles.tab,
							{
								backgroundColor: selected ? theme.accentSoft : theme.surface,
								borderColor: selected ? theme.accent : theme.border,
							},
						]}
					>
						<Text style={{ color: theme.text, fontWeight: selected ? "700" : "500" }}>
							{key === "issues" ? t("forge.issues") : t(`forge.pulls_${forge.kind}`)}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

function ForgeList({ forge, projectId, tab }: { forge: Forge; projectId: string; tab: Tab }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const load = useCallback(
		(): Promise<(ForgeIssue | ForgePull)[]> => (tab === "issues" ? forge.issues() : forge.pulls()),
		[forge, tab],
	);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	if (loading && !data) return <Loading />;
	return (
		<FlatList<ForgeIssue | ForgePull>
			data={data ?? []}
			keyExtractor={(item) => String(item.number)}
			contentContainerStyle={styles.list}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
			ListHeaderComponent={error ? <ErrorBanner message={describeError(error)} /> : undefined}
			ListEmptyComponent={
				error ? undefined : (
					<Text style={{ color: theme.textMuted }}>{tab === "issues" ? t("forge.noIssues") : t("forge.noPulls")}</Text>
				)
			}
			renderItem={({ item }) => (
				<Pressable
					accessibilityRole="button"
					onPress={() =>
						router.push({
							pathname:
								tab === "issues"
									? "/projects/[projectId]/forge/issues/[number]"
									: "/projects/[projectId]/forge/pulls/[number]",
							params: { projectId, number: String(item.number) },
						})
					}
					style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.border }]}
				>
					<Text style={{ color: theme.text, fontWeight: "600" }} numberOfLines={2}>
						#{item.number} {item.title}
					</Text>
					<Text style={{ color: theme.textFaint, fontSize: 12 }}>
						{[
							item.author,
							"head" in item && item.head ? `${item.head} → ${item.base ?? ""}` : null,
							formatDate("updatedAt" in item ? item.updatedAt : item.createdAt, i18n.language),
						]
							.filter(Boolean)
							.join(" · ")}
					</Text>
				</Pressable>
			)}
		/>
	);
}

const styles = StyleSheet.create({
	tabs: { flexDirection: "row", gap: SPACE.sm, padding: SPACE.lg, paddingBottom: 0 },
	tab: { flex: 1, alignItems: "center", borderWidth: 1, borderRadius: RADIUS.md, paddingVertical: SPACE.sm },
	list: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
