/**
 * One file the card's build changed, full screen: its diff coloured, with
 * the line numbers before and after, and the previous or next file a tap
 * away. The files come from the card's changes, named by their place in the
 * list (`?file=`), never by a path the server would have to trust.
 */

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChangedFile } from "../../../../../../api/types";
import { useApi } from "../../../../../../auth/session";
import { FILE_ICONS, lineStyle } from "../../../../../../card/ChangesSection";
import { mono } from "../../../../../../card/LongText";
import { MAX_FULL_PATCH_LINES, type PatchLine, patchLines } from "../../../../../../card/patch";
import { useLoad } from "../../../../../../hooks/useLoad";
import { Button, ErrorBanner, Loading } from "../../../../../../ui/components";
import { Icon } from "../../../../../../ui/Icon";
import { Chip, EmptyState } from "../../../../../../ui/kit";
import { SPACE, TYPE, useTheme } from "../../../../../../ui/theme";

export default function ChangedFileScreen() {
	const { projectId, cardId, file } = useLocalSearchParams<{ projectId: string; cardId: string; file?: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const router = useRouter();
	const load = useCallback(() => api.changes(projectId, cardId), [api, projectId, cardId]);
	const { data, error, loading } = useLoad(load);
	if (loading && !data) return <Loading />;
	const files = data?.files ?? [];
	const index = Math.min(Math.max(Number.parseInt(file ?? "0", 10) || 0, 0), Math.max(files.length - 1, 0));
	const current: ChangedFile | undefined = files[index];
	const go = (to: number) => router.setParams({ file: String(to) });

	return (
		<View style={{ flex: 1 }}>
			<Stack.Screen
				options={{ headerTitle: current ? current.path.slice(current.path.lastIndexOf("/") + 1) : t("card.changes") }}
			/>
			<ErrorBanner error={error} />
			{!current ? (
				<EmptyState icon="file" title={t("card.noChanges")} />
			) : (
				<>
					<View style={[styles.head, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<View style={styles.row}>
							<Icon name={FILE_ICONS[current.status]} size={16} color={theme.textMuted} />
							<Text style={[mono.text, { color: theme.text, flex: 1 }]} selectable>
								{current.path}
							</Text>
						</View>
						<View style={styles.row}>
							<Chip label={t(`cardFiles.status.${current.status}`)} />
							<Text style={{ color: theme.success }}>+{current.additions}</Text>
							<Text style={{ color: theme.danger }}>−{current.deletions}</Text>
							<View style={{ flex: 1 }} />
							<Text style={[TYPE.caption, { color: theme.textMuted }]}>
								{t("cardFiles.position", { index: index + 1, count: files.length })}
							</Text>
						</View>
						<View style={styles.row}>
							<Button
								label={t("cardFiles.previous")}
								icon="chevron-left"
								variant="ghost"
								disabled={index === 0}
								onPress={() => go(index - 1)}
							/>
							<View style={{ flex: 1 }} />
							<Button
								label={t("cardFiles.next")}
								icon="chevron-right"
								variant="ghost"
								disabled={index >= files.length - 1}
								onPress={() => go(index + 1)}
							/>
						</View>
					</View>
					<FullPatch patch={current.patch} />
				</>
			)}
		</View>
	);
}

function FullPatch({ patch }: { patch: string | null }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (!patch) return <Text style={[styles.note, { color: theme.textMuted }]}>{t("card.noPatch")}</Text>;
	const { lines, truncated } = patchLines(patch, MAX_FULL_PATCH_LINES);
	return (
		<ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
			<FlatList<PatchLine>
				data={lines}
				keyExtractor={(line) => String(line.n)}
				contentContainerStyle={styles.lines}
				ListFooterComponent={
					truncated ? <Text style={[styles.note, { color: theme.textMuted }]}>{t("card.patchTruncated")}</Text> : undefined
				}
				renderItem={({ item: line }) => (
					<View style={styles.line}>
						<Text style={[mono.text, styles.number, { color: theme.textFaint }]}>{line.old ?? ""}</Text>
						<Text style={[mono.text, styles.number, { color: theme.textFaint }]}>{line.new ?? ""}</Text>
						<Text style={[mono.text, lineStyle(theme, line.kind)]} selectable>
							{line.text || " "}
						</Text>
					</View>
				)}
			/>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	head: { padding: SPACE.md, gap: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
	row: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	lines: { padding: SPACE.md, paddingBottom: SPACE.xl * 2 },
	line: { flexDirection: "row", gap: SPACE.sm },
	number: { width: 40, textAlign: "right" },
	note: { padding: SPACE.md },
});
