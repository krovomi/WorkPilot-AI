import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../../../../api/client";
import type { GovernanceReport, GovernanceRequest, PolicyDecision, PolicyEvent } from "../../../../api/types";
import { useApi } from "../../../../auth/session";
import { useLoad } from "../../../../hooks/useLoad";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, Loading, Section } from "../../../../ui/components";
import { formatDate } from "../../../../ui/format";
import { RADIUS, SPACE, type Theme, useTheme } from "../../../../ui/theme";

/**
 * The governance of a server project, on the phone: what its
 * workpilot.policy.yaml asks, who approves a call that needs it, the calls its
 * agents wait on, its kill switch and its last decisions. Each button shows
 * only where the server's `may` says the person may act; the server checks
 * every action again (rule S5).
 */
export default function Governance() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => api.governance(projectId), [api, projectId]);
	const { data, error, loading, refreshing, reload, refresh } = useLoad(load);
	const [busy, setBusy] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const act = async (key: string, action: () => Promise<string>, refusal?: (err: unknown) => string | null) => {
		setBusy(key);
		setOutcome(null);
		setFailure(null);
		try {
			setOutcome(await action());
		} catch (err) {
			setFailure(refusal?.(err) ?? describeError(err));
		} finally {
			setBusy(null);
		}
		await refresh();
	};

	if (loading && !data) return <Loading />;
	const reviewers = data?.governance?.files.reviewers ?? [];
	const answer = (request: GovernanceRequest, approved: boolean) =>
		void act(
			`${request.id}:${approved}`,
			async () => {
				const got = await api.answerGovernance(projectId, request.id, approved);
				return t(`governance.${got.answer.decision}`);
			},
			// The server refuses an approval from someone without the roles the policy names.
			(err) =>
				approved && err instanceof ApiError && err.status === 403 && reviewers.length
					? t("governance.needsRole", { roles: reviewers.join(", ") })
					: null,
		);
	const stop = (scope: "mine" | "project") =>
		void act(scope, async () => {
			const got = await api.stopGovernance(projectId, scope);
			return t("governance.stopped", { count: got.stoppedRuns + got.stoppedJobs });
		});
	const stopAll = () =>
		Alert.alert(t("governance.stopTitle"), t("governance.stopBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{ text: t("governance.stopConfirm"), style: "destructive", onPress: () => stop("project") },
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={{ color: theme.textMuted, lineHeight: 21 }}>{t("governance.intro")}</Text>
			<ErrorBanner error={error} />
			<ErrorBanner message={failure} />
			{outcome ? (
				<Text accessibilityRole="summary" style={{ color: theme.success }}>
					{outcome}
				</Text>
			) : null}
			{data ? (
				<>
					<Policy report={data} />
					<Section title={t("governance.agents")}>
						<Text style={{ color: theme.text }}>
							{t("governance.agentsLine", { mine: data.agents.mine, project: data.agents.project })}
						</Text>
						{data.may.stop ? (
							<Button
								label={t("governance.stopMine")}
								variant="secondary"
								busy={busy === "mine"}
								onPress={() => stop("mine")}
							/>
						) : null}
						{data.may.stopProject ? (
							<Button
								label={t("governance.stopProject")}
								variant="danger"
								busy={busy === "project"}
								onPress={stopAll}
							/>
						) : null}
					</Section>
					<Section title={t("governance.pending", { count: data.pending?.length ?? 0 })}>
						{data.pending?.length ? (
							data.pending.map((request) => (
								<Request
									key={request.id}
									request={request}
									canAnswer={data.may.approve}
									busy={busy}
									onAnswer={(approved) => answer(request, approved)}
								/>
							))
						) : (
							<Text style={{ color: theme.textMuted }}>{t("governance.noPending")}</Text>
						)}
					</Section>
					<Decisions report={data} />
				</>
			) : null}
		</ScrollView>
	);
}

function Policy({ report }: { report: GovernanceReport }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const governance = report.governance;
	const errors = report.errors ?? [];
	const number = (n: number) => n.toLocaleString(i18n.language);
	const muted = { color: theme.textMuted };
	return (
		<Section title={t("governance.policy")}>
			{errors.length ? (
				<View accessibilityRole="alert" style={[styles.banner, { backgroundColor: theme.dangerSoft }]}>
					<Text style={{ color: theme.danger, fontWeight: "600" }}>{t("governance.invalid")}</Text>
					{errors.map((e) => (
						<Text key={e} style={{ color: theme.danger, fontFamily: "monospace" }}>
							{e}
						</Text>
					))}
				</View>
			) : null}
			{!governance && !errors.length ? <Text style={muted}>{t("governance.none")}</Text> : null}
			{governance ? (
				<>
					<Label text={t("governance.schedule")} />
					{governance.schedule ? (
						<>
							<Text style={{ color: governance.schedule.openNow ? theme.success : theme.danger, fontWeight: "600" }}>
								{t(governance.schedule.openNow ? "governance.openNow" : "governance.closedNow")}
							</Text>
							<Text style={{ color: theme.text }}>
								{t("governance.scheduleLine", {
									hours: governance.schedule.allowedHours.join(", "),
									timezone: governance.schedule.timezone,
									days: governance.schedule.days.join(", "),
								})}
							</Text>
						</>
					) : (
						<Text style={muted}>{t("governance.noSchedule")}</Text>
					)}
					<Label text={t("governance.forbidden")} />
					<Globs globs={governance.files.forbidden} />
					<Label text={t("governance.requiresReview")} />
					<Globs globs={governance.files.requiresReview} />
					{governance.files.requiresReview.length ? (
						<Text style={muted} testID="governance-approver">
							{governance.files.reviewers?.length
								? t("governance.reviewers", { roles: governance.files.reviewers.join(", ") })
								: t("governance.anyMember")}
						</Text>
					) : null}
					<Label text={t("governance.budget")} />
					{governance.budget?.maxTokensPerHour ? (
						<Text style={{ color: theme.text }}>
							{t("governance.budgetLine", {
								spent: number(report.tokensLastHour ?? 0),
								limit: number(governance.budget.maxTokensPerHour),
							})}
						</Text>
					) : null}
					{governance.budget?.maxTokensPerTask ? (
						<Text style={{ color: theme.text }}>
							{t("governance.taskBudgetLine", { limit: number(governance.budget.maxTokensPerTask) })}
						</Text>
					) : null}
					{governance.budget ? null : <Text style={muted}>{t("governance.noBudget")}</Text>}
					{governance.loopDetection ? (
						<Text style={{ color: theme.text }}>
							{t("governance.loopLine", { count: governance.loopDetection.maxSameToolCall })}
						</Text>
					) : null}
				</>
			) : null}
		</Section>
	);
}

function Label({ text }: { text: string }) {
	const theme = useTheme();
	return <Text style={{ color: theme.textMuted, fontWeight: "600", marginTop: SPACE.xs }}>{text}</Text>;
}

function Globs({ globs }: { globs: string[] }) {
	const { t } = useTranslation();
	const theme = useTheme();
	if (!globs.length) return <Text style={{ color: theme.textMuted }}>{t("governance.noFiles")}</Text>;
	return (
		<View style={styles.globs}>
			{globs.map((glob) => (
				<Text key={glob} style={[styles.glob, { color: theme.text, backgroundColor: theme.elevated }]}>
					{glob}
				</Text>
			))}
		</View>
	);
}

function Request({
	request,
	canAnswer,
	busy,
	onAnswer,
}: {
	request: GovernanceRequest;
	canAnswer: boolean;
	busy: string | null;
	onAnswer: (approved: boolean) => void;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const target = request.target?.summary;
	const meta = [request.task, formatDate(request.at, i18n.language)].filter(Boolean).join(" · ");
	return (
		<View style={[styles.row, { borderColor: theme.border }]} testID="governance-request">
			<Text style={{ color: theme.text, fontWeight: "600" }}>{(request.rules ?? []).join(", ")}</Text>
			{target ? (
				<Text style={{ color: theme.text, fontFamily: "monospace" }}>
					{request.tool ? `${request.tool} · ${target}` : target}
				</Text>
			) : null}
			{meta ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{meta}</Text> : null}
			{canAnswer ? (
				<View style={styles.line}>
					<View style={{ flex: 1 }}>
						<Button
							label={t("governance.refuse")}
							variant="secondary"
							busy={busy === `${request.id}:false`}
							disabled={busy !== null}
							onPress={() => onAnswer(false)}
						/>
					</View>
					<View style={{ flex: 1 }}>
						<Button
							label={t("governance.approve")}
							busy={busy === `${request.id}:true`}
							disabled={busy !== null}
							onPress={() => onAnswer(true)}
						/>
					</View>
				</View>
			) : null}
		</View>
	);
}

const TONES: Record<PolicyDecision, (theme: Theme) => string> = {
	deny: (theme) => theme.danger,
	invalid_policy: (theme) => theme.danger,
	approved: (theme) => theme.success,
	review: (theme) => theme.accent,
	warn: (theme) => theme.textMuted,
	outside_hours: (theme) => theme.textMuted,
	budget_exceeded: (theme) => theme.textMuted,
	tool_loop: (theme) => theme.textMuted,
};

function Decisions({ report }: { report: GovernanceReport }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const events = (report.events ?? []).filter((e) => e.decision in TONES).slice(0, 20);
	return (
		<Section title={t("governance.decisions")}>
			<Text style={{ color: theme.textMuted }}>
				{t("governance.blocked", { count: report.metrics?.blocked24h ?? 0 })}
			</Text>
			<Text style={{ color: theme.textMuted }}>
				{t("governance.trips", { count: report.metrics?.breakerTrips7d ?? 0 })}
			</Text>
			{events.length ? (
				events.map((event, index) => <Decision key={event.id ?? index} event={event} />)
			) : (
				<Text style={{ color: theme.textMuted }}>{t("governance.noDecisions")}</Text>
			)}
		</Section>
	);
}

function Decision({ event }: { event: PolicyEvent }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const meta = [event.task, formatDate(event.at, i18n.language)].filter(Boolean).join(" · ");
	return (
		<View style={[styles.row, { borderColor: theme.border }]}>
			<Text style={{ color: TONES[event.decision](theme), fontWeight: "600" }}>
				{t(`governance.decision.${event.decision}`)}
			</Text>
			{event.rules?.length ? <Text style={{ color: theme.text }}>{event.rules.join(", ")}</Text> : null}
			{event.target ? (
				<Text style={{ color: theme.text, fontFamily: "monospace" }}>
					{event.tool ? `${event.tool} · ${event.target}` : event.target}
				</Text>
			) : null}
			{event.approvedBy ? (
				<Text style={{ color: theme.textMuted }}>{t("governance.approvedBy", { name: event.approvedBy })}</Text>
			) : null}
			{meta ? <Text style={{ color: theme.textFaint, fontSize: 12 }}>{meta}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	banner: { borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	globs: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
	glob: { fontFamily: "monospace", fontSize: 12, paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm, overflow: "hidden" },
	row: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: 2 },
	line: { flexDirection: "row", gap: SPACE.sm, marginTop: SPACE.xs },
});
