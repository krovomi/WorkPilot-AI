import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ExecutionWavePlan, WaveHistory, WaveRunAnswer } from "../../../../api/types";
import { useApi, useSession } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

type Advance = "merged" | "review";

/**
 * The execution waves of a server project, on the phone (#358): the server
 * plans the backlog from its clone (cards that share no file run side by
 * side), runs "Execute in optimal order" wave after wave, and counts what it
 * avoided. Opening the screen takes the run's next step for someone who may
 * start agents; the server checks every action again (rule S5).
 */
export default function Waves() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const mayRun = can("agent.execute");
	const load = useCallback(async () => {
		const [plan, current, history] = await Promise.all([
			api.wavePlan(projectId),
			api.waveRun(projectId),
			api.waveHistory(projectId),
		]);
		const run = current.run && mayRun ? await api.stepWaveRun(projectId) : current;
		return { plan, run, history };
	}, [api, projectId, mayRun]);
	const { data, error, loading, refreshing, reload, refresh } = useLoad(load);
	const [advance, setAdvance] = useState<Advance>("merged");
	const [busy, setBusy] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const act = async (key: string, action: () => Promise<unknown>) => {
		setBusy(key);
		setFailure(null);
		try {
			await action();
		} catch (err) {
			setFailure(describeError(err));
		} finally {
			setBusy(null);
		}
		await refresh();
	};
	const stop = () =>
		Alert.alert(t("waves.stopTitle"), t("waves.stopBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{ text: t("waves.stop"), style: "destructive", onPress: () => void act("stop", () => api.stopWaveRun(projectId)) },
		]);

	if (loading && !data) return <Loading />;
	const muted = { color: theme.textMuted };
	const titles = new Map(data?.plan.tasks.map((task) => [task.taskId, task.title]));
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={[muted, { lineHeight: 21 }]}>{t("waves.intro")}</Text>
			<ErrorBanner error={error} />
			<ErrorBanner message={failure} />
			{data ? (
				<>
					{data.run.run ? (
						<RunView answer={data.run} />
					) : (
						<Section title={t("waves.execute")}>
							{data.run.ended === "done" ? <Text style={muted}>{t("waves.finished")}</Text> : null}
							{data.run.ignored ? <Text style={muted}>{t("waves.ignored")}</Text> : null}
							{mayRun && data.plan.waves.length ? (
								<>
									<View style={styles.row}>
										{(["merged", "review"] as const).map((rule) => (
											<Button
												key={rule}
												label={t(`waves.advance.${rule}`)}
												variant={advance === rule ? "primary" : "secondary"}
												accessibilityState={{ selected: advance === rule }}
												style={{ flex: 1 }}
												onPress={() => setAdvance(rule)}
											/>
										))}
									</View>
									<Button
										label={t("waves.start")}
										busy={busy === "start"}
										onPress={() => void act("start", () => api.startWaveRun(projectId, advance))}
									/>
								</>
							) : (
								<Text style={muted}>{data.plan.waves.length ? t("waves.noRight") : t("waves.empty")}</Text>
							)}
						</Section>
					)}
					{data.run.run ? (
						<View style={styles.row}>
							{mayRun ? (
								<Button
									label={t("waves.step")}
									variant="secondary"
									busy={busy === "step"}
									style={{ flex: 1 }}
									onPress={() => void act("step", () => api.stepWaveRun(projectId))}
								/>
							) : null}
							{can("task.write") ? (
								<Button
									label={t("waves.stop")}
									variant="danger"
									busy={busy === "stop"}
									style={{ flex: 1 }}
									onPress={stop}
								/>
							) : null}
						</View>
					) : null}
					<PlanView plan={data.plan} titles={titles} />
					<Section title={t("waves.history", { days: data.history.summary.days })}>
						{data.history.ignored ? <Text style={muted}>{t("waves.historyIgnored")}</Text> : null}
						<Text style={{ color: theme.text }} testID="waves-history">
							{t("waves.historyLine", {
								runs: data.history.summary.runs,
								stopped: data.history.summary.stopped,
								conflicts: data.history.summary.conflictsAvoided,
								risk: data.history.summary.riskAvoided,
								started: data.history.summary.started,
							})}
						</Text>
						<ConflictTimes conflicts={data.history.conflicts} />
						{data.history.summary.lastFinishedAt ? (
							<Text style={muted}>
								{t("waves.lastRun", { at: formatDate(data.history.summary.lastFinishedAt, i18n.language) })}
							</Text>
						) : null}
					</Section>
				</>
			) : null}
		</ScrollView>
	);
}

/** "12 min", "3 h 05 min": a time the server measured. */
function duration(seconds: number, t: TFunction): string {
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) return t("waves.minutes", { count: minutes });
	return t("waves.hours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

/** How long the residual merge conflicts took to resolve, as the server measured it. */
function ConflictTimes({ conflicts }: { conflicts: WaveHistory["conflicts"] }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (conflicts.ignored) return <Text style={{ color: theme.textMuted }}>{t("waves.conflictsIgnored")}</Text>;
	if (!conflicts.resolved && !conflicts.open) return null;
	return (
		<Text style={{ color: theme.text }} testID="waves-conflicts">
			{conflicts.medianSeconds === null
				? t("waves.conflictsNone", { open: conflicts.open })
				: t("waves.conflictsLine", {
						resolved: conflicts.resolved,
						median: duration(conflicts.medianSeconds, t),
						open: conflicts.open,
					})}
		</Text>
	);
}

function RunView({ answer }: { answer: WaveRunAnswer }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const run = answer.run as NonNullable<WaveRunAnswer["run"]>;
	const cards = new Map((answer.cards ?? []).map((card) => [card.id, card]));
	const blocked = new Set(answer.blocked ?? []);
	return (
		<Section
			title={t("waves.running", {
				wave: Math.min(run.current + 1, run.waves.length),
				total: run.waves.length,
			})}
		>
			<Text style={{ color: theme.textMuted }}>{t(`waves.advance.${run.advanceWhen}`)}</Text>
			{run.waves.map((wave, index) => (
				<View
					key={wave.join(",")}
					testID="waves-run-wave"
					style={[
						styles.wave,
						{ borderColor: index === run.current ? theme.accent : theme.border, backgroundColor: theme.surface },
					]}
				>
					<Text style={{ color: theme.text, fontWeight: "700" }}>{t("waves.wave", { index: index + 1 })}</Text>
					{wave.map((id) => {
						const card = cards.get(id);
						const failure = run.failures[id];
						const note = failure
							? t(`waves.failure.${failure}`)
							: blocked.has(id)
								? t("waves.blocked")
								: card?.column
									? t(`columns.${card.column}`)
									: t("waves.gone");
						return (
							<Text key={id} style={{ color: failure ? theme.danger : theme.text }}>
								{`${card?.title ?? id} · ${note}${card?.running ? ` · ${t("waves.agentRunning")}` : ""}`}
							</Text>
						);
					})}
				</View>
			))}
		</Section>
	);
}

function PlanView({ plan, titles }: { plan: ExecutionWavePlan; titles: Map<string, string> }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const muted = { color: theme.textMuted };
	return (
		<Section title={t("waves.plan", { count: plan.waves.length, parallel: plan.maxParallel })}>
			{plan.waves.length ? (
				<Text style={muted}>
					{t("waves.risk", { avoided: Math.max(0, plan.totalRisk - plan.residualRisk), total: plan.totalRisk })}
				</Text>
			) : null}
			{plan.mergeChecks.checked ? (
				<Text style={muted}>
					{t("waves.mergeChecks", { checked: plan.mergeChecks.checked, conflicts: plan.mergeChecks.conflicts })}
				</Text>
			) : null}
			{plan.cycles.length ? (
				<View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
					<Text style={{ color: theme.danger, fontWeight: "600" }}>{t("waves.cycles")}</Text>
					{plan.excluded.map((excluded) => (
						<Text key={excluded.taskId} style={{ color: theme.danger }}>
							{`${titles.get(excluded.taskId) ?? excluded.taskId} · ${t(`waves.excluded.${excluded.reason}`)}`}
						</Text>
					))}
				</View>
			) : null}
			{plan.waves.map((wave) => (
				<View
					key={wave.index}
					testID="waves-plan-wave"
					style={[styles.wave, { borderColor: theme.border, backgroundColor: theme.surface }]}
				>
					<Text style={{ color: theme.text, fontWeight: "700" }}>{t("waves.wave", { index: wave.index })}</Text>
					{wave.taskIds.map((id) => (
						<Text key={id} style={{ color: theme.text }}>
							{titles.get(id) ?? id}
						</Text>
					))}
				</View>
			))}
		</Section>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	row: { flexDirection: "row", gap: SPACE.sm },
	wave: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	banner: { borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
});
