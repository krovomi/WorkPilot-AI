/**
 * Where a share from another app lands (`+native-intent.tsx` sends the
 * system's `workpilot://expo-sharing` here): the shared text becomes the start
 * of a new card in the project the person picks. Nothing is created here;
 * the New card screen shows the text and waits for Create.
 */

import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ServerProject } from "../../api/types";
import { useApi } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { readIncomingShare } from "../../new-card/incoming";
import { holdShareDraft } from "../../new-card/share";
import { Button, Centered, ErrorBanner, Loading } from "../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../ui/theme";

export default function ShareIntoCard() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const router = useRouter();
	const [draft] = useState(readIncomingShare);
	const load = useCallback(() => api.projects(), [api]);
	const { data, error, loading } = useLoad(load);

	if (!draft) {
		return (
			<Centered>
				<Text style={{ color: theme.textMuted, textAlign: "center" }}>{t("share.nothing")}</Text>
				<Button label={t("share.back")} variant="secondary" onPress={() => router.replace("/")} />
			</Centered>
		);
	}
	if (loading && !data) return <Loading />;

	const pick = (project: ServerProject) => {
		holdShareDraft(draft);
		router.replace({ pathname: "/projects/[projectId]/new", params: { projectId: project.id, shared: "1" } });
	};

	return (
		<FlatList<ServerProject>
			data={data ?? []}
			keyExtractor={(p) => p.id}
			contentContainerStyle={styles.list}
			ListHeaderComponent={
				<View style={{ gap: SPACE.md }}>
					{error ? <ErrorBanner message={describeError(error)} /> : null}
					<Text style={{ color: theme.text, fontWeight: "600" }}>{t("share.pickProject")}</Text>
					<Text style={[styles.preview, { color: theme.textMuted, borderColor: theme.border }]} numberOfLines={4}>
						{draft.description}
					</Text>
				</View>
			}
			ListEmptyComponent={
				error ? undefined : <Text style={{ color: theme.textMuted, textAlign: "center" }}>{t("projects.empty")}</Text>
			}
			renderItem={({ item }) => (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={item.name}
					onPress={() => pick(item)}
					style={({ pressed }) => [
						styles.row,
						{ backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.85 : 1 },
					]}
				>
					<Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>{item.name}</Text>
				</Pressable>
			)}
		/>
	);
}

const styles = StyleSheet.create({
	list: { padding: SPACE.lg, gap: SPACE.md },
	preview: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
	row: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.lg },
});
