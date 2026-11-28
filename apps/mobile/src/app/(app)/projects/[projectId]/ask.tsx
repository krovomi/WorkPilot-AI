import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useApi } from "../../../../auth/session";
import { type AskMatch, type AskTurn, historyOf } from "../../../../board-ask/types";
import { JOB_ACTIVE } from "../../../../features/types";
import { JOB_POLL_MS } from "../../../../features/useFeature";
import { describeError } from "../../../../i18n";
import { Button, ErrorBanner, KeyboardAvoiding } from "../../../../ui/components";
import { Chip } from "../../../../ui/kit";
import { RADIUS, SPACE, useTheme } from "../../../../ui/theme";

const MAX_QUESTION = 1000;

/**
 * « Interroger le tableau »: a question about the board, in any language,
 * answered by the server with the tickets that relate to it (`shared_board/ask.py`).
 * The conversation lives on this screen; a follow-up carries the turns before it.
 */
export default function AskBoard() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [question, setQuestion] = useState("");
	const [turns, setTurns] = useState<AskTurn[]>([]);
	const [pending, setPending] = useState<{ jobId: string; question: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const turnIds = useRef(0);

	// While the server answers, read the job again until it ends.
	useEffect(() => {
		if (!pending) return;
		const timer = setInterval(async () => {
			try {
				const { job, result } = await api.boardAnswer(projectId, pending.jobId);
				if (JOB_ACTIVE.has(job.status)) return;
				setPending(null);
				if (result) {
					turnIds.current += 1;
					const id = turnIds.current;
					setTurns((before) => [...before, { id, question: pending.question, result }]);
				}
				else if (job.status !== "cancelled") setError(job.error || t("ask.noAnswer"));
			} catch (err) {
				setPending(null);
				setError(describeError(err));
			}
		}, JOB_POLL_MS);
		return () => clearInterval(timer);
	}, [api, pending, projectId, t]);

	const send = async () => {
		const asked = question.trim();
		setError(null);
		try {
			const { job } = await api.askBoard(projectId, {
				question: asked,
				language: i18n.language.slice(0, 2),
				history: historyOf(turns),
			});
			setPending({ jobId: job.id, question: asked });
			setQuestion("");
		} catch (err) {
			setError(describeError(err));
		}
	};

	const stop = async (jobId: string) => {
		try {
			await api.cancelBoardAsk(projectId, jobId);
		} catch (err) {
			setError(describeError(err));
		}
	};

	return (
		<KeyboardAvoiding>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				{turns.length === 0 && !pending ? <Text style={{ color: theme.textMuted }}>{t("ask.intro")}</Text> : null}
				{turns.map((turn) => (
					<Turn key={turn.id} turn={turn} projectId={projectId} />
				))}
				{pending ? (
					<View style={styles.row}>
						<Text style={{ color: theme.textMuted, flex: 1 }}>{t("ask.answering", { question: pending.question })}</Text>
						<Button label={t("ask.stop")} variant="secondary" onPress={() => void stop(pending.jobId)} />
					</View>
				) : null}
				<ErrorBanner message={error} />
			</ScrollView>
			<View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
				<TextInput
					accessibilityLabel={t("ask.question")}
					placeholder={turns.length ? t("ask.followUp") : t("ask.question")}
					placeholderTextColor={theme.textFaint}
					value={question}
					onChangeText={setQuestion}
					maxLength={MAX_QUESTION}
					multiline
					style={[styles.input, { color: theme.text, borderColor: theme.border }]}
				/>
				<Button label={t("ask.send")} disabled={!question.trim() || !!pending} onPress={() => void send()} />
			</View>
		</KeyboardAvoiding>
	);
}

function Turn({ turn, projectId }: { turn: AskTurn; projectId: string }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const { result } = turn;
	return (
		<View style={styles.turn}>
			<View style={[styles.bubble, { alignSelf: "flex-end", backgroundColor: theme.accentSoft }]}>
				<Text style={{ color: theme.text }} selectable>
					{turn.question}
				</Text>
			</View>
			{result.answer ? (
				<Text style={{ color: theme.text, lineHeight: 21 }} selectable>
					{result.answer}
				</Text>
			) : (
				<Text style={{ color: theme.textMuted }}>
					{result.matches.length ? t("ask.keywords") : t("ask.nothing")}
				</Text>
			)}
			{result.matches.map((match, index) => (
				<MatchRow key={match.taskId} match={match} index={index + 1} projectId={projectId} />
			))}
			<Text style={{ color: theme.textFaint, fontSize: 12 }}>{t("ask.searched", { count: result.searched })}</Text>
		</View>
	);
}

const COVERAGE_COLORS = { full: "success", partial: "warning", related: "textMuted" } as const;

function MatchRow({ match, index, projectId }: { match: AskMatch; index: number; projectId: string }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	// Only a card opens; a roadmap feature or an idea has its own page.
	const open = match.kind
		? undefined
		: () => router.push({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId, cardId: match.taskId } });
	return (
		<Pressable
			accessibilityRole={open ? "button" : undefined}
			accessibilityLabel={match.title}
			onPress={open}
			disabled={!open}
			style={[styles.match, { borderColor: theme.border, backgroundColor: theme.surface }]}
		>
			<Text style={{ color: theme.text, fontWeight: "600" }}>{`[${index}] ${match.title}`}</Text>
			<View style={styles.chips}>
				<Chip label={t(`ask.state.${match.state}`)} />
				{match.kind ? <Chip label={t(`ask.kind.${match.kind}`)} /> : null}
				{match.coverage ? (
					<Chip label={t(`ask.coverage.${match.coverage}`)} color={theme[COVERAGE_COLORS[match.coverage]]} />
				) : null}
				{match.archived ? <Chip label={t("ask.archived")} /> : null}
			</View>
			{match.reason ? <Text style={{ color: theme.textMuted }}>{match.reason}</Text> : null}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl },
	turn: { gap: SPACE.sm },
	row: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	bubble: { maxWidth: "88%", borderRadius: RADIUS.lg, padding: SPACE.md },
	match: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
	composer: { flexDirection: "row", alignItems: "flex-end", gap: SPACE.sm, padding: SPACE.sm, borderTopWidth: 1 },
	input: { flex: 1, maxHeight: 140, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm },
});
