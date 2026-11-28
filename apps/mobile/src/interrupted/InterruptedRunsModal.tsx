/**
 * The prompt the desktop shows at launch, on the phone: the runs the team
 * server stopped, each with where it stopped and where it will resume; the
 * person's own ticked, a teammate's (seen by a project owner) and one that
 * cannot resume unticked. « Resume » asks the server to start each again from
 * where it stopped; « Later », or closing, sets the others aside on the
 * server. A run the server refused stays listed with its reason.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Api } from "../api/endpoints";
import { Button, ErrorBanner } from "../ui/components";
import { timeAgo } from "../ui/format";
import { Icon } from "../ui/Icon";
import { Chip } from "../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import { type InterruptedRun, STEPS, selectedByDefault, stepOf } from "./types";

const K = "interrupted";

function Steps({ run }: { run: InterruptedRun }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const current = STEPS.indexOf(stepOf(run));
	return (
		<View style={styles.steps}>
			{STEPS.map((step, index) => {
				const done = index < current;
				const here = index === current;
				const label =
					step === "coding" && here && run.subtasks_total > 0
						? t(`${K}.steps.codingCount`, { done: run.subtasks_done, total: run.subtasks_total })
						: t(`${K}.steps.${step}`);
				return (
					<View
						key={step}
						style={[
							styles.step,
							{
								borderColor: here ? theme.accent : done ? "transparent" : theme.border,
								backgroundColor: done ? theme.accentSoft : "transparent",
							},
						]}
					>
						<Text
							style={[
								TYPE.caption,
								{ color: here || done ? theme.text : theme.textMuted, fontWeight: here ? "700" : "500" },
							]}
						>
							{label}
						</Text>
					</View>
				);
			})}
		</View>
	);
}

function Row({
	run,
	checked,
	error,
	onToggle,
}: {
	run: InterruptedRun;
	checked: boolean;
	error: unknown;
	onToggle: () => void;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const ago = timeAgo(run.interrupted_at, t, i18n.language);
	const where =
		run.phase === "coding" && run.next_subtask
			? t(`${K}.where.subtask`, { subtask: run.next_subtask })
			: t(`${K}.where.${run.phase}`);
	return (
		<Pressable
			accessibilityRole="checkbox"
			accessibilityLabel={run.title}
			accessibilityState={{ checked }}
			onPress={onToggle}
			style={[
				styles.row,
				{ borderColor: checked ? theme.accent : theme.border, backgroundColor: checked ? theme.accentSoft : "transparent" },
			]}
		>
			<Icon name={checked ? "check-square" : "square"} size={20} color={checked ? theme.accent : theme.textMuted} />
			<View style={styles.rowBody}>
				<Text style={[TYPE.body, { color: theme.text, fontWeight: "600" }]}>{run.title}</Text>
				<View style={styles.chips}>
					<Chip label={run.project_name} icon="folder" />
					{run.model ? <Chip label={run.model} icon="cpu" /> : null}
					<Chip
						label={ago ? t(`${K}.originWithTime`, { ago }) : t(`${K}.origin`)}
						icon="server"
						color={theme.warning}
					/>
				</View>
				<Steps run={run} />
				<Text style={[TYPE.small, { color: theme.textMuted }]}>{where}</Text>
				{run.started_by_name ? (
					<Text style={[TYPE.small, { color: theme.textMuted }]}>
						{t(`${K}.startedBy`, { name: run.started_by_name })}
					</Text>
				) : null}
				{run.blocker ? (
					<Text style={[TYPE.small, { color: theme.danger }]}>{t(`${K}.blocker.${run.blocker}`)}</Text>
				) : null}
				<ErrorBanner error={error} />
			</View>
		</Pressable>
	);
}

export function InterruptedRunsModal({
	api,
	runs,
	onClose,
}: {
	api: Pick<Api, "resumeRun" | "setInterruptedRunsAside">;
	runs: InterruptedRun[];
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [shown, setShown] = useState(runs);
	const [selected, setSelected] = useState(() => new Set(runs.filter(selectedByDefault).map((run) => run.run_id)));
	const [errors, setErrors] = useState<Record<string, unknown>>({});
	const [busy, setBusy] = useState(false);

	const toggle = (runId: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(runId)) next.delete(runId);
			else next.add(runId);
			return next;
		});

	// Both buttons are disabled while an answer is sent.
	const answer = async (resume: boolean) => {
		setBusy(true);
		const chosen = resume ? shown.filter((run) => selected.has(run.run_id)) : [];
		const refused: Record<string, unknown> = {};
		for (const run of chosen) {
			try {
				await api.resumeRun(run.project_id, run.spec_id, run.run_id);
			} catch (error) {
				refused[run.run_id] = error;
			}
		}
		const rest = shown.filter((run) => !chosen.includes(run));
		if (rest.length > 0) {
			// The server stops offering them, here and on the desktop.
			await api.setInterruptedRunsAside(rest.map((run) => run.run_id)).catch(() => undefined);
		}
		setBusy(false);
		const left = chosen.filter((run) => refused[run.run_id] !== undefined);
		if (left.length === 0) {
			onClose();
			return;
		}
		setShown(left);
		setErrors(refused);
	};

	return (
		<Modal
			visible
			transparent
			animationType="fade"
			testID="interrupted-runs"
			onRequestClose={() => void answer(false)}
		>
			<View style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
				<View style={[styles.card, { backgroundColor: theme.surface }]}>
					<Text accessibilityRole="header" style={[TYPE.heading, { color: theme.text }]}>
						{t(`${K}.title`, { count: shown.length })}
					</Text>
					<Text style={[TYPE.small, { color: theme.textMuted }]}>{t(`${K}.description`)}</Text>
					<Text style={[TYPE.caption, { color: theme.textMuted }]}>
						{t(`${K}.selected`, { count: selected.size, total: shown.length })}
					</Text>
					<ScrollView contentContainerStyle={{ gap: SPACE.sm }}>
						{shown.map((run) => (
							<Row
								key={run.run_id}
								run={run}
								checked={selected.has(run.run_id)}
								error={errors[run.run_id]}
								onToggle={() => toggle(run.run_id)}
							/>
						))}
					</ScrollView>
					<View style={styles.actions}>
						<Button
							label={t(`${K}.later`)}
							variant="secondary"
							disabled={busy}
							onPress={() => void answer(false)}
							style={{ flex: 1 }}
						/>
						<Button
							label={t(`${K}.resume`, { count: selected.size })}
							icon="play"
							busy={busy}
							disabled={selected.size === 0}
							onPress={() => void answer(true)}
							style={{ flex: 1 }}
						/>
					</View>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	backdrop: { flex: 1, justifyContent: "center", padding: SPACE.lg },
	card: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.sm, maxHeight: "90%" },
	row: { flexDirection: "row", gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
	rowBody: { flex: 1, gap: 6 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
	steps: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
	step: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 },
	actions: { flexDirection: "row", gap: SPACE.sm, marginTop: SPACE.xs },
});
