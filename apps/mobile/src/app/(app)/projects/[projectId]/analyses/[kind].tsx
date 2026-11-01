import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi } from "../../../../../auth/session";
import { JobBar } from "../../../../../features/JobBar";
import { type FeatureJob, JOB_ACTIVE } from "../../../../../features/types";
import { JOB_POLL_MS } from "../../../../../features/useFeature";
import { useLoad } from "../../../../../hooks/useLoad";
import { describeError } from "../../../../../i18n";
import { digest, readSaved } from "../../../../../insights/digest";
import { Figures } from "../../../../../insights/Figures";
import { ANALYSES, type AnalysisKind } from "../../../../../insights/types";
import { ErrorBanner, Loading, Section } from "../../../../../ui/components";
import { formatDate } from "../../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../../ui/theme";

export default function Analysis() {
	const { projectId, kind: raw } = useLocalSearchParams<{ projectId: string; kind: string }>();
	const kind = (ANALYSES as readonly string[]).includes(raw) ? (raw as AnalysisKind) : null;
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(
		async () => (kind ? readSaved(await api.analysisReport(kind, projectId)) : null),
		[api, kind, projectId],
	);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [job, setJob] = useState<FeatureJob | null>(null);
	const [lastLine, setLastLine] = useState<string | null>(null);
	const active = !!job && JOB_ACTIVE.has(job.status);
	const jobId = job?.id;

	useEffect(() => {
		if (!active || !jobId || !kind) return;
		const timer = setInterval(async () => {
			try {
				const out = await api.analysisJob(kind, projectId, jobId);
				const line = out.lines.filter((l) => l.trim() && !/^[A-Z0-9_]+_RESULT:|^\{/.test(l)).at(-1);
				if (line) setLastLine(line.slice(0, 300));
				setJob(out);
				if (!JOB_ACTIVE.has(out.status)) await reload();
			} catch {
				// Read again at the next tick.
			}
		}, JOB_POLL_MS);
		return () => clearInterval(timer);
	}, [active, jobId, kind, api, projectId, reload]);

	if (!kind) return <ErrorBanner message={t("analyses.unknown")} />;
	if (loading && !data) return <Loading />;
	const report = data ? digest(data.report) : null;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ title: t(`analyses.kinds.${kind}.title`) }} />
			<Text style={{ color: theme.textMuted }}>{t(`analyses.kinds.${kind}.body`)}</Text>
			<ErrorBanner message={error ? describeError(error) : null} />
			<JobBar
				job={job}
				active={active}
				lastLine={lastLine}
				hasContent={!!data}
				onStart={async () => {
					setLastLine(null);
					setJob(await api.startAnalysis(kind, projectId));
				}}
				onCancel={async () => {
					if (jobId) await api.cancelAnalysis(kind, projectId, jobId);
				}}
			/>
			{!data || !report ? (
				<Text style={{ color: theme.textMuted }}>{t("analyses.none")}</Text>
			) : (
				<>
					<Text style={{ color: theme.textFaint }}>
						{t("analyses.lastRun", { date: formatDate(data.finished_at, i18n.language) })}
					</Text>
					{report.figures.length ? (
						<Section title={t("analyses.summary")}>
							<Figures rows={report.figures} />
						</Section>
					) : null}
					{report.lists.map((list) => (
						<Section key={list.label} title={`${list.label} (${list.total})`}>
							{list.items.map((item) => (
								<View
									key={`${list.label}:${item.n}`}
									style={[styles.item, { borderColor: theme.border }]}
								>
									<Text style={{ color: theme.text, fontWeight: "600" }}>{item.title}</Text>
									{item.level ? <Text style={{ color: theme.accent, fontSize: 12 }}>{item.level}</Text> : null}
									{item.detail ? <Text style={{ color: theme.textMuted }}>{item.detail}</Text> : null}
								</View>
							))}
							{list.total > list.items.length ? (
								<Text style={{ color: theme.textFaint }}>
									{t("analyses.more", { count: list.total - list.items.length })}
								</Text>
							) : null}
						</Section>
					))}
				</>
			)}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	item: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: 2, borderRadius: RADIUS.sm },
});
