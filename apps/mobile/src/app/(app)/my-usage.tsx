/**
 * My usage: what the organization's administrators see of the person over
 * the last 30 days (totals, action names, runs and jobs, never their
 * content), which roles read it, everything the server keeps about them to
 * share as a JSON file (RGPD articles 15 and 20), and the notice to read again.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../ui/components";
import { dateLocale, formatDate, formatDay } from "../../ui/format";
import { SPACE, TYPE, useTheme } from "../../ui/theme";
import { periodOf } from "../../usage/period";
import type { MyUsage, UsageNotice } from "../../usage/types";
import { UsageNoticeModal } from "../../usage/UsageNoticeModal";

/** The timeline is long; the phone shows its most recent entries. */
const TIMELINE = 50;

export default function MyUsageScreen() {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => {
		const { start, end } = periodOf(30);
		return api.myUsage(start, end);
	}, [api]);
	const { data, error, loading, refreshing, reload } = useLoad<MyUsage>(load);
	const [notice, setNotice] = useState<UsageNotice | null>(null);
	const [busy, setBusy] = useState<"export" | "notice" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const number = new Intl.NumberFormat(dateLocale(i18n.language));
	const usd = new Intl.NumberFormat(dateLocale(i18n.language), { style: "currency", currency: "USD" });

	const run = async (which: "export" | "notice", action: () => Promise<void>) => {
		setBusy(which);
		setActionError(null);
		try {
			await action();
		} catch (err) {
			setActionError(describeError(err));
		} finally {
			setBusy(null);
		}
	};
	const exportAll = () =>
		run("export", async () => {
			await Share.share({ title: t("myUsage.exportTitle"), message: await api.exportMyUsage() });
		});
	const showNotice = () =>
		run("notice", async () => {
			setNotice(await api.usageNotice());
		});

	if (loading && !data) return <Loading />;
	const days = new Map<string, number>();
	for (const row of data?.daily ?? []) days.set(row.day, (days.get(row.day) ?? 0) + row.tokens);
	const muted = { color: theme.textMuted };
	const line = { color: theme.text };
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={[TYPE.small, muted]}>{t("myUsage.intro")}</Text>
			<ErrorBanner error={error} />
			<ErrorBanner message={actionError} />
			{data ? (
				<>
					<Text style={[TYPE.small, line]}>{t("myUsage.visibleTo", { roles: data.visible_to.join(", ") })}</Text>
					<Section title={t("myUsage.period")} icon="bar-chart-2">
						<Text style={[TYPE.body, line]}>
							{t("myUsage.tokens", { count: data.summary.tokens.total, value: number.format(data.summary.tokens.total) })}
						</Text>
						<Text style={[TYPE.small, muted]}>
							{t(data.summary.estimated ? "myUsage.costEstimated" : "myUsage.cost", {
								cost: usd.format(data.summary.cost_usd),
							})}
						</Text>
						<Text style={[TYPE.small, muted]}>
							{t("myUsage.runs", { total: data.summary.runs.total, succeeded: data.summary.runs.succeeded })}
						</Text>
						<Text style={[TYPE.small, muted]}>
							{t("myUsage.jobs", { total: data.summary.jobs.total, succeeded: data.summary.jobs.succeeded })}
						</Text>
					</Section>
					<Section title={t("myUsage.daily")} icon="calendar">
						{days.size === 0 ? <Text style={[TYPE.small, muted]}>{t("myUsage.empty")}</Text> : null}
						{[...days].sort(([a], [b]) => b.localeCompare(a)).map(([day, tokens]) => (
							<View key={day} style={styles.row}>
								<Text style={[TYPE.small, line, { flex: 1 }]}>{formatDay(day, i18n.language)}</Text>
								<Text style={[TYPE.small, muted]}>{number.format(tokens)}</Text>
							</View>
						))}
					</Section>
					<Section title={t("myUsage.timeline")} icon="clock">
						{data.timeline.length === 0 ? <Text style={[TYPE.small, muted]}>{t("myUsage.empty")}</Text> : null}
						{data.timeline.slice(0, TIMELINE).map((event) => (
							<View key={`${event.at}-${event.kind}-${event.what}`} style={styles.event}>
								<Text style={[TYPE.caption, muted]}>{formatDate(event.at, i18n.language)}</Text>
								<Text style={[TYPE.small, line]}>
									{t("myUsage.event", {
										kind: t(`myUsage.kinds.${event.kind}`),
										what: event.status ? `${event.what} · ${event.status}` : event.what,
									})}
								</Text>
							</View>
						))}
					</Section>
					{data.pages.pages.length > 0 ? (
						<Section title={t("myUsage.pages")} icon="layout">
							{data.pages.pages.map((row) => (
								<View key={`${row.client}/${row.page}`} style={styles.row}>
									<Text style={[TYPE.small, line, { flex: 1 }]}>{row.page}</Text>
									<Text style={[TYPE.small, muted]}>{number.format(row.opens)}</Text>
								</View>
							))}
						</Section>
					) : null}
				</>
			) : null}
			<Button label={t("myUsage.export")} variant="secondary" busy={busy === "export"} onPress={() => void exportAll()} />
			<Button label={t("myUsage.notice")} variant="secondary" busy={busy === "notice"} onPress={() => void showNotice()} />
			<UsageNoticeModal notice={notice} onClose={() => setNotice(null)} />
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.md },
	row: { flexDirection: "row", gap: SPACE.sm, paddingVertical: 2 },
	event: { paddingVertical: 4 },
});
