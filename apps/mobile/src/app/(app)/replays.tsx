/**
 * The replay links the person shared, on every project of the organization
 * they still reach: how often each was opened, until when it opens, and
 * ending one now. Links are made from WorkPilot on the computer; the server
 * checks again that the person may end the one they tap.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import type { ReplayShare, ShareState } from "../../team/types";
import { Button, ErrorBanner, Loading } from "../../ui/components";
import { formatDate, timeAgo } from "../../ui/format";
import { Chip, EmptyState } from "../../ui/kit";
import { elevation, RADIUS, SPACE, TYPE, type Theme, useTheme } from "../../ui/theme";

function stateColor(theme: Theme, state: ShareState): string {
	if (state === "active") return theme.success;
	return state === "expired" ? theme.warning : theme.textFaint;
}

export default function MyReplays() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => api.myReplayShares(), [api]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [busy, setBusy] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const revoke = (share: ReplayShare) =>
		Alert.alert(t("replays.revokeTitle"), t("replays.revokeBody", { title: share.title }), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("replays.revoke"),
				style: "destructive",
				onPress: async () => {
					setBusy(share.id);
					setActionError(null);
					try {
						await api.revokeReplayShare(share.project_id, share.id);
						await reload();
					} catch (err) {
						setActionError(describeError(err));
					} finally {
						setBusy(null);
					}
				},
			},
		]);

	if (loading && !data) return <Loading />;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={error ? describeError(error) : actionError} />
			<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("replays.hint")}</Text>
			{data?.length === 0 ? <EmptyState icon="film" title={t("replays.empty")} hint={t("replays.emptyHint")} /> : null}
			{data?.map((share) => (
				<ShareRow
					key={share.id}
					share={share}
					busy={busy === share.id}
					disabled={busy !== null}
					color={stateColor(theme, share.state)}
					onRevoke={() => revoke(share)}
				/>
			))}
		</ScrollView>
	);
}

function ShareRow({
	share,
	busy,
	disabled,
	color,
	onRevoke,
}: {
	share: ReplayShare;
	busy: boolean;
	disabled: boolean;
	color: string;
	onRevoke: () => void;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const opened = share.open_count
		? t("replays.opened", { count: share.open_count, when: timeAgo(share.last_opened_at, t, i18n.language) })
		: t("replays.neverOpened");
	return (
		<View style={[styles.share, { backgroundColor: theme.surface }, elevation(theme)]}>
			<View style={styles.head}>
				<Text style={[TYPE.body, { color: theme.text, fontWeight: "600", flex: 1 }]} numberOfLines={2}>
					{share.title}
				</Text>
				<Chip label={t(`replays.state.${share.state}`)} color={color} />
			</View>
			<Text style={[TYPE.small, { color: theme.textMuted }]}>
				{t("replays.where", { project: share.project_name, count: share.steps })}
			</Text>
			<Text style={[TYPE.small, { color: theme.textMuted }]}>{opened}</Text>
			{share.state === "active" && share.expires_at ? (
				<Text style={[TYPE.small, { color: theme.textMuted }]}>
					{t("replays.until", { date: formatDate(share.expires_at, i18n.language) })}
				</Text>
			) : null}
			{share.state === "active" && share.can_revoke ? (
				<Button
					label={t("replays.revoke")}
					variant="danger"
					icon="slash"
					busy={busy}
					disabled={disabled}
					onPress={onRevoke}
				/>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
	share: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.xs },
	head: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm },
});
