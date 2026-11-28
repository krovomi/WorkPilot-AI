import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AgentRun } from "../../../../../api/types";
import { confirmSensitive } from "../../../../../auth/lock";
import { useApi, useSession } from "../../../../../auth/session";
import {
	activeRun,
	allowedActions,
	availableActions,
	type CardAction,
	runPhase,
	sendBack,
	startCard,
	stopCard,
} from "../../../../../board/actions";
import { ACTION_ICONS } from "../../../../../board/actionIcons";
import { ACTIVE_COLUMNS, boardColumn } from "../../../../../board/columns";
import { ApprovalSection } from "../../../../../card/ApprovalSection";
import { CapturesSection } from "../../../../../card/CapturesSection";
import { ChangesSection } from "../../../../../card/ChangesSection";
import { LogsSection } from "../../../../../card/LogsSection";
import { canEditCard, EditCard } from "../../../../../card/EditCard";
import { LongText } from "../../../../../card/LongText";
import { SettingsSection } from "../../../../../card/SettingsSection";
import { SteeringSection } from "../../../../../card/SteeringSection";
import { useCard } from "../../../../../board/useCard";
import { describeError } from "../../../../../i18n";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../../../ui/components";
import { formatDate, timeAgo } from "../../../../../ui/format";
import { Icon, type IconName } from "../../../../../ui/Icon";
import { Avatar, Chip } from "../../../../../ui/kit";
import { columnColor, RADIUS, SPACE, TYPE, useTheme } from "../../../../../ui/theme";

const WORKING_POLL_MS = 5_000;


export default function CardScreen() {
	const { projectId, cardId } = useLocalSearchParams<{ projectId: string; cardId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const router = useRouter();
	const { data, error, loading, refreshing, reload, refresh } = useCard(projectId, cardId);
	const [busy, setBusy] = useState<CardAction | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [editing, setEditing] = useState(false);
	// Bumped after each action, so the approval section reads the server again.
	const [revision, setRevision] = useState(0);
	const working = !!data && (!!activeRun(data.runs) || ACTIVE_COLUMNS.has(data.card.column));

	// While an agent works on the card, read it again: its column, runs and
	// changes move without anyone touching the phone.
	useEffect(() => {
		if (!working) return;
		// refresh, not reload: a background read must not spin pull-to-refresh.
		const timer = setInterval(() => void refresh(), WORKING_POLL_MS);
		return () => clearInterval(timer);
	}, [working, refresh]);

	if (loading && !data) return <Loading />;
	if (!data) {
		return (
			<ScrollView contentContainerStyle={styles.content}>
				<ErrorBanner message={describeError(error)} />
				<Button label={t("common.retry")} onPress={() => void reload()} />
			</ScrollView>
		);
	}

	const { card, details, runs, changes, logs } = data;
	const actions = allowedActions(availableActions(card, details, runs), can);
	const editable = can("task.write") && canEditCard(details, working);

	const run = async (action: CardAction, work: () => Promise<unknown>) => {
		setBusy(action);
		setActionError(null);
		try {
			await work();
			await reload();
			return true;
		} catch (err) {
			setActionError(describeError(err));
			return false;
		} finally {
			setBusy(null);
			setRevision((n) => n + 1);
		}
	};

	// Merge and pull request cannot be taken back from the phone: the lock asks first.
	const runConfirmed = async (action: CardAction, work: () => Promise<unknown>) => {
		if (!(await confirmSensitive(t("lock.actionPrompt"), t("common.cancel")))) return false;
		return run(action, work);
	};

	const perform = (action: CardAction) => {
		switch (action) {
			case "start":
				return run(action, () => startCard(api, projectId, card, details));
			case "approve":
				return run(action, () => api.approve(projectId, card.id));
			case "stop":
				return run(action, () => stopCard(api, projectId, card));
			case "retry":
				return run(action, () => runPhase(api, projectId, card, "build"));
			case "merge":
				return runConfirmed(action, () => runPhase(api, projectId, card, "merge"));
			case "createPr":
				return runConfirmed(action, () => runPhase(api, projectId, card, "pr"));
			case "requestChanges":
				setFeedbackOpen(true);
				return;
			case "delete":
				Alert.alert(t("card.deleteConfirmTitle"), t("card.deleteConfirmBody"), [
					{ text: t("common.cancel"), style: "cancel" },
					{
						text: t("actions.delete"),
						style: "destructive",
						onPress: async () => {
							if (!(await confirmSensitive(t("lock.actionPrompt"), t("common.cancel")))) return;
							setBusy("delete");
							try {
								await api.deleteCard(projectId, card.id);
								router.back();
							} catch (err) {
								setActionError(describeError(err));
							} finally {
								setBusy(null);
							}
						},
					},
				]);
				return;
		}
	};

	const submitFeedback = async () => {
		const ok = await run("requestChanges", () => sendBack(api, projectId, card, feedback));
		if (ok) {
			setFeedback("");
			setFeedbackOpen(false);
		}
	};

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Stack.Screen options={{ headerTitle: card.id.split("-")[0] }} />
      <View style={{ gap: SPACE.sm }}>
        <View style={styles.columnRow}>
          <View style={[styles.status, { backgroundColor: theme.elevated }]}>
            <View style={[styles.dot, { backgroundColor: columnColor(theme, boardColumn(card)) }]} />
            <Text style={[TYPE.caption, { color: theme.text, fontWeight: "700" }]}>
              {t(`columns.${boardColumn(card)}`)}
            </Text>
          </View>
          {card.kind ? <Chip label={t(`kinds.${card.kind}`)} /> : null}
          {working ? <Chip label={t("card.working")} icon="activity" color={theme.accent} /> : null}
        </View>
				<Text accessibilityRole="header" style={[TYPE.title, { color: theme.text }]}>
					{card.title}
				</Text>
				{card.claimedByName ? (
					<View style={styles.columnRow}>
						<Avatar name={card.claimedByName} size={22} />
						<Text style={[TYPE.small, { color: theme.textMuted, flexShrink: 1 }]}>
							{t("board.claimedBy", { name: card.claimedByName })}
							{card.updatedAt ? ` · ${timeAgo(card.updatedAt, t, i18n.language)}` : ""}
						</Text>
					</View>
				) : null}
			</View>

			<ErrorBanner message={actionError} error={error} />

			{actions.length > 0 ? (
				<View style={styles.actions}>
					{actions.map((action) => (
						<Button
							key={action}
							label={t(`actions.${action}`)}
							icon={ACTION_ICONS[action]}
							variant={action === "delete" || action === "stop" ? "danger" : action === actions[0] ? "primary" : "secondary"}
							busy={busy === action}
							disabled={!!busy}
							onPress={() => void perform(action)}
						/>
					))}
				</View>
			) : null}

			{feedbackOpen ? (
				<Section title={t("card.feedbackTitle")}>
					<Field
						label={t("card.feedbackTitle")}
						placeholder={t("card.feedbackPlaceholder")}
						value={feedback}
						onChangeText={setFeedback}
						multiline
						autoFocus
					/>
					<View style={styles.inline}>
						<Button label={t("common.cancel")} variant="secondary" onPress={() => setFeedbackOpen(false)} style={{ flex: 1 }} />
						<Button
							label={t("card.send")}
							busy={busy === "requestChanges"}
							disabled={!feedback.trim()}
							onPress={() => void submitFeedback()}
							style={{ flex: 1 }}
						/>
					</View>
				</Section>
			) : null}

			{editing ? (
				<EditCard
					projectId={projectId}
					details={details}
					onCancel={() => setEditing(false)}
					onSaved={async () => {
						setEditing(false);
						await reload();
					}}
				/>
			) : (
				<Section title={t("card.description")} icon="align-left">
					<Text style={{ color: theme.text, lineHeight: 22 }} selectable>
						{details.description}
					</Text>
					{editable ? (
						<Button label={t("card.edit")} icon="edit-3" variant="secondary" onPress={() => setEditing(true)} />
					) : null}
				</Section>
			)}

			<SettingsSection settings={details.settings} />

			<Section title={t("card.spec")} icon="file-text">
				{details.spec ? (
					<LongText text={details.spec} showLabel={t("card.showSpec")} hideLabel={t("card.hideSpec")} />
				) : (
					<Text style={{ color: theme.textMuted }}>{t("card.noSpec")}</Text>
				)}
			</Section>

			{details.spec ? (
				<ApprovalSection
					// Read again after each action on the card (an approval, a change of plan).
					key={`${cardId}-${revision}`}
					projectId={projectId}
					cardId={cardId}
					fallback={
						details.approval.approved
							? t("card.approvedBy", { name: details.approval.approvedBy ?? "?" })
							: t("card.notApproved")
					}
				/>
			) : null}

			{details.qaReport ? (
				<Section title={t("card.qaReport")} icon="check-square">
					<LongText text={details.qaReport} showLabel={t("card.showReport")} hideLabel={t("card.hideReport")} />
				</Section>
			) : null}

			<ChangesSection
				changes={changes}
				onOpenFile={(file) =>
					router.push({
						pathname: "/projects/[projectId]/cards/[cardId]/files",
						params: { projectId, cardId, file: String(file) },
					})
				}
			/>

			<CapturesSection
				key={`captures-${revision}`}
				projectId={projectId}
				cardId={cardId}
				onOpen={() =>
					router.push({
						pathname: "/projects/[projectId]/cards/[cardId]/captures",
						params: { projectId, cardId, specId: card.specId ?? "" },
					})
				}
			/>

			{data.card.column !== "done" ? (
				<SteeringSection
					projectId={projectId}
					cardId={cardId}
					canSend={can("agent.execute")}
					working={working}
				/>
			) : null}

			<LogsSection
				logs={logs}
				onOpen={() => router.push({ pathname: "/projects/[projectId]/cards/[cardId]/logs", params: { projectId, cardId } })}
			/>

			<Section title={t("card.runs")} icon="play-circle">
				{runs.length === 0 ? (
					<Text style={{ color: theme.textMuted }}>{t("card.noRuns")}</Text>
				) : (
					runs.slice(0, 10).map((r) => <RunRow key={r.id} run={r} locale={i18n.language} />)
				)}
			</Section>
		</ScrollView>
	);
}

/** A run's colour and icon: an interrupted run waits to be resumed, it did not fail. */
function runLook(status: string, theme: ReturnType<typeof useTheme>): { color: string; icon: IconName } {
	if (status === "succeeded") return { color: theme.success, icon: "check-circle" };
	if (status === "failed") return { color: theme.danger, icon: "x-circle" };
	if (status === "interrupted") return { color: theme.warning, icon: "pause-circle" };
	return { color: theme.textMuted, icon: "loader" };
}

function RunRow({ run, locale }: { run: AgentRun; locale: string }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const status = i18n.exists(`runStatus.${run.status}`) ? t(`runStatus.${run.status}`) : run.status;
	const phase = i18n.exists(`runPhase.${run.phase}`) ? t(`runPhase.${run.phase}`) : run.phase;
	const { color, icon } = runLook(run.status, theme);
	return (
		<View style={[styles.run, { borderColor: theme.border }]}>
			<Icon name={icon} size={18} color={color} />
			<View style={{ flex: 1 }}>
				<Text style={{ color: theme.text, fontWeight: "600" }}>{phase}</Text>
				<Text style={{ color: theme.textFaint, fontSize: 12 }}>{formatDate(run.started_at, locale)}</Text>
				{run.error ? (
					<Text style={{ color: theme.danger, fontSize: 12 }} numberOfLines={3}>
						{run.error}
					</Text>
				) : null}
			</View>
			<Text style={{ color }}>{status}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	columnRow: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" },
	status: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		borderRadius: RADIUS.pill,
		paddingHorizontal: SPACE.sm + 2,
		paddingVertical: 4,
	},
	dot: { width: 8, height: 8, borderRadius: 4 },
	actions: { gap: SPACE.sm },
	inline: { flexDirection: "row", gap: SPACE.sm },
	run: {
		flexDirection: "row",
		alignItems: "center",
		gap: SPACE.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		paddingTop: SPACE.sm,
	},
});
