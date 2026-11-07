import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { Comments } from "../../../../../../forge/Comments";
import { useForge } from "../../../../../../forge/useForge";
import { useLoad } from "../../../../../../hooks/useLoad";
import { describeError } from "../../../../../../i18n";
import { ErrorBanner, Loading, Section } from "../../../../../../ui/components";
import { formatDate } from "../../../../../../ui/format";
import { SPACE, useTheme } from "../../../../../../ui/theme";

export default function IssueScreen() {
	const { projectId, number } = useLocalSearchParams<{ projectId: string; number: string }>();
	const n = Number(number);
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { forge, loading: forgeLoading, error: forgeError } = useForge(projectId);
	const load = useCallback(async () => {
		if (!forge) return null;
		const [issue, comments] = await Promise.all([forge.issue(n), forge.issueComments(n)]);
		return { issue, comments };
	}, [forge, n]);
	const { data, error, loading, refreshing, reload } = useLoad(load);

	if (forgeLoading || (loading && !data)) return <Loading />;
	if (!forge || !data) return <ErrorBanner message={describeError(forgeError ?? error ?? t("forge.none"))} />;
	const { issue, comments } = data;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ title: `#${issue.number}` }} />
			<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
				{issue.title}
			</Text>
			<Text style={{ color: theme.textFaint }}>
				{[issue.state, issue.author, formatDate(issue.createdAt, i18n.language)].filter(Boolean).join(" · ")}
			</Text>
			<ErrorBanner message={error ? describeError(error) : null} />
			<Section title={t("card.description")}>
				<Text style={{ color: theme.text, lineHeight: 22 }} selectable>
					{issue.body || t("forge.noDescription")}
				</Text>
			</Section>
			<Comments
				comments={comments}
				canComment={forge.canCommentIssues}
				onSend={async (body) => {
					await forge.commentIssue(n, body);
					await reload();
				}}
			/>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	title: { fontSize: 22, fontWeight: "700" },
});
