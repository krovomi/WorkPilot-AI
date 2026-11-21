/**
 * The approvals lent on a project (holidays, on-call): who lends to whom and
 * until when, ending one, and lending one's own to a colleague for a number
 * of days. The server checks the colleague, the period and who may end one
 * (`shared_board/approvals.py`); the phone only offers the project's writers.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Delegation, ProjectMember } from "../../../../api/types";
import { useApi, useSession } from "../../../../auth/session";
import { lendingEnd, parseDays } from "../../../../card/delegations";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

interface Loaded {
	delegations: Delegation[];
	members: ProjectMember[];
}

export default function Delegations() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { user } = useSession();
	const load = useCallback(async (): Promise<Loaded> => {
		const [delegations, members] = await Promise.all([api.delegations(projectId), api.members(projectId)]);
		return { delegations, members };
	}, [api, projectId]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [to, setTo] = useState<string | null>(null);
	const [days, setDays] = useState("7");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const act = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setActionError(null);
		try {
			await work();
			await reload();
			return true;
		} catch (err) {
			setActionError(describeError(err));
			return false;
		} finally {
			setBusy(false);
		}
	};

	if (loading && !data) return <Loading />;
	const colleagues = (data?.members ?? []).filter(
		(m) => m.user_id !== user?.id && (m.role === "member" || m.role === "owner"),
	);
	const count = parseDays(days);
	// The lending the form describes, once it describes one.
	const request = to !== null && count !== null ? { to, count } : null;
	const lend = async ({ to: colleague, count: period }: { to: string; count: number }) => {
		if (await act(() => api.lendApproval(projectId, colleague, lendingEnd(period)))) setTo(null);
	};

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ headerTitle: t("delegations.title") }} />
			<ErrorBanner message={error ? describeError(error) : null} />
			<Text style={{ color: theme.textMuted }}>{t("delegations.hint")}</Text>
			<Section title={t("delegations.current")}>
				{data?.delegations.length ? (
					data.delegations.map((d) => (
						<View key={d.id} style={[styles.row, { borderColor: theme.border }]}>
							<Text style={{ color: theme.text, flex: 1 }}>
								{t("delegations.item", {
									from: d.from.name,
									to: d.to.name,
									start: formatDate(d.startsAt, i18n.language),
									end: formatDate(d.endsAt, i18n.language),
								})}
							</Text>
							<Text style={{ color: d.active ? theme.success : theme.textFaint, fontSize: 12 }}>
								{t(d.active ? "delegations.active" : "delegations.planned")}
							</Text>
							<Button
								label={t("delegations.end")}
								variant="danger"
								disabled={busy}
								onPress={() => void act(() => api.endDelegation(projectId, d.id))}
							/>
						</View>
					))
				) : (
					<Text style={{ color: theme.textMuted }}>{t("delegations.empty")}</Text>
				)}
			</Section>
			<Section title={t("delegations.lendTitle")}>
				{colleagues.length ? (
					colleagues.map((m) => {
						const selected = to === m.user_id;
						return (
							<Pressable
								key={m.user_id}
								accessibilityRole="radio"
								accessibilityState={{ selected }}
								onPress={() => setTo(m.user_id)}
								style={[
									styles.person,
									{ borderColor: selected ? theme.accent : theme.border, backgroundColor: theme.surface },
								]}
							>
								<Text style={{ color: selected ? theme.accent : theme.text }}>{m.display_name || m.email}</Text>
							</Pressable>
						);
					})
				) : (
					<Text style={{ color: theme.textMuted }}>{t("delegations.noColleague")}</Text>
				)}
				<Field label={t("delegations.days")} value={days} onChangeText={setDays} keyboardType="number-pad" />
				<ErrorBanner message={actionError} />
				<Button
					label={t("delegations.lend")}
					busy={busy}
					disabled={!request || busy}
					onPress={request ? () => void lend(request) : undefined}
				/>
			</Section>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg },
	row: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, borderBottomWidth: 1, paddingVertical: SPACE.sm },
	person: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
});
