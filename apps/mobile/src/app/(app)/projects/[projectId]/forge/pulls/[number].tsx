import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useSession } from "../../../../../../auth/session";
import { ChangesSection } from "../../../../../../card/ChangesSection";
import { LongText } from "../../../../../../card/LongText";
import { AiReview } from "../../../../../../forge/AiReview";
import { Comments } from "../../../../../../forge/Comments";
import { useForge } from "../../../../../../forge/useForge";
import { useLoad } from "../../../../../../hooks/useLoad";
import { describeError } from "../../../../../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../../../../../ui/components";
import { SPACE, useTheme } from "../../../../../../ui/theme";

export default function PullScreen() {
	const { projectId, number } = useLocalSearchParams<{ projectId: string; number: string }>();
	const n = Number(number);
	const { t } = useTranslation();
	const theme = useTheme();
	const { can } = useSession();
	const { forge, loading: forgeLoading, error: forgeError } = useForge(projectId);
	const load = useCallback(async () => {
		if (!forge) return null;
		const [pull, files, comments] = await Promise.all([forge.pull(n), forge.pullFiles(n), forge.pullComments(n)]);
		const checks = pull.headSha ? await forge.checks(pull.headSha).catch(() => null) : null;
		return { pull, files, comments, checks };
	}, [forge, n]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	if (forgeLoading || (loading && !data)) return <Loading />;
	if (!forge || !data) return <ErrorBanner message={describeError(forgeError ?? error ?? t("forge.none"))} />;
	const { pull, files, comments, checks } = data;
	const open = pull.state === "open" || pull.state === "opened";

	const merge = () =>
		Alert.alert(t("forge.mergeTitle", { number: pull.number }), t("forge.mergeBody", { base: pull.base ?? "" }), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("actions.merge"),
				onPress: async () => {
					setBusy(true);
					setActionError(null);
					try {
						await forge.merge(n);
						await reload();
					} catch (err) {
						setActionError(describeError(err));
					} finally {
						setBusy(false);
					}
				},
			},
		]);

	const additions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
	const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ title: `#${pull.number}` }} />
			<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
				{pull.title}
			</Text>
			<Text style={{ color: theme.textFaint }}>
				{[t(`forge.state.${pull.state}`, { defaultValue: pull.state }), pull.author, `${pull.head ?? ""} → ${pull.base ?? ""}`]
					.filter(Boolean)
					.join(" · ")}
			</Text>
			{checks ? (
				<Text style={{ color: checks.failed ? theme.danger : checks.pending ? theme.textMuted : theme.success }}>
					{t("forge.checks", checks)}
				</Text>
			) : null}
			<ErrorBanner message={actionError ?? (error ? describeError(error) : null)} />
			{open && can("vcs.write") && can("vcs.pr.merge") ? (
				<Button
					label={t("actions.merge")}
					busy={busy}
					disabled={pull.mergeable === false}
					onPress={merge}
				/>
			) : null}
			{pull.body ? (
				<Section title={t("card.description")}>
					<LongText text={pull.body} showLabel={t("card.showSpec")} hideLabel={t("card.hideSpec")} />
				</Section>
			) : null}
			<AiReview forge={forge} number={n} />
			<ChangesSection
				changes={{
					exists: true,
					filesChanged: files.length,
					additions,
					deletions,
					files: files.map((f) => ({
						path: f.path,
						status: "modified",
						additions: f.additions ?? 0,
						deletions: f.deletions ?? 0,
						patch: f.patch,
					})),
				}}
			/>
			<Comments
				comments={comments}
				canComment={open}
				onSend={async (body) => {
					await forge.commentPull(n, body);
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
