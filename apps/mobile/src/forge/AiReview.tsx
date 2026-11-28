/**
 * The AI review of a pull or merge request, run on the server as a job: the
 * saved review (its verdict, summary and findings), and a button to run it,
 * or a follow-up once one exists, followed until the job ends.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useSession } from "../auth/session";
import { JOB_ACTIVE } from "../features/types";
import { JOB_POLL_MS } from "../features/useFeature";
import { useLoad } from "../hooks/useLoad";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Section } from "../ui/components";
import { RADIUS, SPACE, type Theme, useTheme } from "../ui/theme";
import type { Forge } from "./forge";
import { FindingFeedback, HeldFeedbackList, useReviewFeedback } from "./ReviewFeedback";
import type { ReviewFeedbackApi, ReviewFinding } from "./types";

export function severityColor(theme: Theme, severity: string): string {
	if (severity === "critical" || severity === "high") return theme.danger;
	if (severity === "medium") return theme.accent;
	return theme.textMuted;
}

export function AiReview({ forge, number }: { forge: Forge; number: number }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { can } = useSession();
	const load = useCallback(async () => (await forge.reviews([number]))[String(number)] ?? null, [forge, number]);
	const { data: review, reload } = useLoad(load);
	const [jobId, setJobId] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const running = !!jobId && (!status || JOB_ACTIVE.has(status));

	useEffect(() => {
		if (!running || !jobId) return;
		const timer = setInterval(async () => {
			try {
				const job = await forge.reviewJob(jobId);
				setStatus(job.status);
				if (!JOB_ACTIVE.has(job.status)) {
					if (job.status === "failed") setError(t("features.jobFailed", { error: job.error ?? "" }));
					await reload();
				}
			} catch {
				// Read again at the next tick.
			}
		}, JOB_POLL_MS);
		return () => clearInterval(timer);
	}, [running, jobId, forge, reload, t]);

	const start = async () => {
		setError(null);
		try {
			const job = await forge.startReview(number, !!review);
			setStatus(job.status);
			setJobId(job.id);
		} catch (err) {
			setError(describeError(err));
		}
	};

	const verdict = review?.verdict
		? i18n.exists(`forge.verdict.${review.verdict}`)
			? t(`forge.verdict.${review.verdict}`)
			: review.verdict
		: null;
	return (
		<Section title={t("forge.aiReview")}>
			<ErrorBanner message={error} />
			{review ? (
				<>
					{verdict ? <Text style={{ color: theme.text, fontWeight: "700" }}>{verdict}</Text> : null}
					{review.summary ? (
						<Text style={{ color: theme.text, lineHeight: 21 }} selectable>
							{review.summary}
						</Text>
					) : null}
					{forge.feedback ? (
						<FindingsWithFeedback api={forge.feedback} number={number} findings={review.findings} />
					) : (
						review.findings.map((f) => <Finding key={f.id} finding={f} />)
					)}
				</>
			) : (
				<Text style={{ color: theme.textMuted }}>{t("forge.noReview")}</Text>
			)}
			{running ? (
				<Text style={{ color: theme.textMuted }}>{t("features.jobRunning")}</Text>
			) : can("agent.execute") && can("vcs.write") ? (
				<Button
					label={review ? t("forge.followupReview") : t("forge.runReview")}
					variant="secondary"
					onPress={() => void start()}
				/>
			) : null}
		</Section>
	);
}

function Finding({ finding: f, children }: { finding: ReviewFinding; children?: ReactNode }) {
	const theme = useTheme();
	return (
		<View style={[styles.finding, { borderColor: theme.border }]}>
			<Text style={{ color: severityColor(theme, f.severity), fontWeight: "700", fontSize: 12 }}>
				{f.severity.toUpperCase()}
				{f.file ? ` · ${f.file}${f.line ? `:${f.line}` : ""}` : ""}
			</Text>
			<Text style={{ color: theme.text, fontWeight: "600" }}>{f.title}</Text>
			<Text style={{ color: theme.textMuted, lineHeight: 20 }} selectable>
				{f.description}
			</Text>
			{children}
		</View>
	);
}

/** The findings with what the team said of each, and the rejections waiting for a maintainer. */
function FindingsWithFeedback({
	api,
	number,
	findings,
}: {
	api: ReviewFeedbackApi;
	number: number;
	findings: readonly ReviewFinding[];
}) {
	const state = useReviewFeedback(api, number);
	return (
		<>
			{findings.map((f) => (
				<Finding key={f.id} finding={f}>
					<FindingFeedback state={state} findingId={f.id} />
				</Finding>
			))}
			<HeldFeedbackList state={state} />
		</>
	);
}

const styles = StyleSheet.create({
	finding: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.sm, gap: SPACE.xs, borderRadius: RADIUS.sm },
});
