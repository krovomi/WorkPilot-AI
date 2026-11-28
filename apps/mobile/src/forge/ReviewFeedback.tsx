/**
 * Feedback on the findings of an AI review (#361): a teammate says a remark
 * was useful, wrong (and why) or does not apply here, and the project's
 * reviewer learns from it. A rejection by someone who is not a maintainer
 * waits for one, who approves or discards it here. GitHub only, as the
 * server's route; the server checks who may say what.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../auth/session";
import { useLoad } from "../hooks/useLoad";
import { describeError } from "../i18n";
import { Button, ErrorBanner } from "../ui/components";
import { Chip } from "../ui/kit";
import { SPACE, TYPE, type Theme, useTheme } from "../ui/theme";
import {
	FEEDBACK_REASONS,
	type FeedbackReason,
	type FeedbackVerdict,
	type FeedbackView,
	type HeldFeedback,
	type ReviewFeedbackApi,
} from "./types";

export interface ReviewFeedbackState {
	view: FeedbackView | null;
	/** This pull's held rejections, for a maintainer; empty otherwise. */
	held: HeldFeedback[];
	busy: string | null;
	error: string | null;
	canSend: boolean;
	send(findingId: string, verdict: FeedbackVerdict, reason: FeedbackReason | null): Promise<void>;
	decide(findingId: string, approve: boolean): Promise<void>;
}

export function useReviewFeedback(api: ReviewFeedbackApi, number: number): ReviewFeedbackState {
	const { can } = useSession();
	const load = useCallback(async () => {
		const view = await api.forPull(number);
		// The held list comes with the project's dataset: read only when this pull has some.
		if (!view.held.length) return { view, held: [] };
		const all = await api.held();
		return { view, held: all.maintainer ? all.held.filter((h) => h.pr === number) : [] };
	}, [api, number]);
	const { data, refresh } = useLoad(load);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const act = async (findingId: string, work: () => Promise<unknown>) => {
		setBusy(findingId);
		setError(null);
		try {
			await work();
			await refresh();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(null);
		}
	};
	return {
		view: data?.view ?? null,
		held: data?.held ?? [],
		busy,
		error,
		canSend: can("task.write"),
		send: (findingId, verdict, reason) => act(findingId, () => api.send(number, findingId, verdict, reason)),
		decide: (findingId, approve) => act(findingId, () => api.decideHeld(number, findingId, approve)),
	};
}

function verdictColor(theme: Theme, verdict: FeedbackVerdict): string {
	if (verdict === "accepted") return theme.success;
	return verdict === "rejected" ? theme.danger : theme.textMuted;
}

/** Under one finding: what the team said of it, and saying it. */
export function FindingFeedback({ state, findingId }: { state: ReviewFeedbackState; findingId: string }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [asking, setAsking] = useState(false);
	const verdict = state.view?.feedback[findingId];
	const held = state.view?.held.includes(findingId) ?? false;
	const busy = state.busy === findingId;
	const send = async (next: FeedbackVerdict, reason: FeedbackReason | null) => {
		setAsking(false);
		await state.send(findingId, next, reason);
	};
	return (
		<View style={styles.feedback}>
			{verdict ? (
				<View style={styles.row}>
					<Chip label={t(`forge.feedback.verdict.${verdict}`)} color={verdictColor(theme, verdict)} />
					{held ? <Chip icon="clock" label={t("forge.feedback.held")} /> : null}
				</View>
			) : null}
			{state.canSend && state.view ? (
				<View style={styles.row}>
					<Button
						label={t("forge.feedback.useful")}
						icon="thumbs-up"
						variant="ghost"
						busy={busy}
						disabled={state.busy !== null || verdict === "accepted"}
						onPress={() => void send("accepted", null)}
					/>
					<Button
						label={t("forge.feedback.notUseful")}
						icon="thumbs-down"
						variant="ghost"
						disabled={state.busy !== null}
						onPress={() => setAsking((open) => !open)}
					/>
				</View>
			) : null}
			{asking ? (
				<View style={styles.reasons}>
					<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("forge.feedback.why")}</Text>
					{FEEDBACK_REASONS.map((reason) => (
						<Button
							key={reason}
							label={t(`forge.feedback.reason.${reason}`)}
							variant="secondary"
							onPress={() => void send("rejected", reason)}
						/>
					))}
					<Button
						label={t("forge.feedback.notApplicable")}
						variant="ghost"
						onPress={() => void send("not_applicable", null)}
					/>
				</View>
			) : null}
		</View>
	);
}

/** The rejections of this pull that wait for a maintainer, who settles them. */
export function HeldFeedbackList({ state }: { state: ReviewFeedbackState }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	return (
		<>
			<ErrorBanner message={state.error} />
			{state.held.length ? (
				<View style={[styles.held, { borderColor: theme.border }]}>
					<Text style={[TYPE.label, { color: theme.text }]}>{t("forge.feedback.heldTitle")}</Text>
					<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("forge.feedback.heldHint")}</Text>
					{state.held.map((item) => (
						<View key={item.finding_id} style={styles.heldItem}>
							<Text style={{ color: theme.text, fontWeight: "600" }}>{item.title}</Text>
							<Text style={[TYPE.small, { color: theme.textMuted }]}>
								{[
									t(`forge.feedback.verdict.${item.verdict}`),
									item.reason && i18n.exists(`forge.feedback.reason.${item.reason}`)
										? t(`forge.feedback.reason.${item.reason}`)
										: null,
								]
									.filter(Boolean)
									.join(" · ")}
							</Text>
							<View style={styles.row}>
								<Button
									label={t("forge.feedback.approve")}
									icon="check"
									variant="secondary"
									busy={state.busy === item.finding_id}
									disabled={state.busy !== null}
									onPress={() => void state.decide(item.finding_id, true)}
								/>
								<Button
									label={t("forge.feedback.discard")}
									icon="x"
									variant="ghost"
									disabled={state.busy !== null}
									onPress={() => void state.decide(item.finding_id, false)}
								/>
							</View>
						</View>
					))}
				</View>
			) : null}
		</>
	);
}

const styles = StyleSheet.create({
	feedback: { gap: SPACE.xs },
	row: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm, alignItems: "center" },
	reasons: { gap: SPACE.xs },
	held: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: SPACE.sm },
	heldItem: { gap: SPACE.xs },
});
