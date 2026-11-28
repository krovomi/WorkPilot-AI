/**
 * The memories of a server project, and what the team decides on them: pin
 * one (kept from the trash and from the purge), forget one (to the trash,
 * restorable for the days the server keeps it), restore one. Deciding is
 * `insight.write`; a viewer reads.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useApi, useSession } from "../auth/session";
import { useLoad } from "../hooks/useLoad";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field, Loading } from "../ui/components";
import { formatDate } from "../ui/format";
import { Chip, EmptyState } from "../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../ui/theme";
import type { Memory } from "./index-file";
import { type ForgottenMemory, MemoryRefused } from "./lifecycle";

/** What a refused or failed decision says. */
function useDecisionError() {
	const { t, i18n } = useTranslation();
	return useCallback(
		(err: unknown) => {
			if (!(err instanceof MemoryRefused)) return describeError(err);
			const key = `context.refused.${err.code}`;
			return i18n.exists(key) ? t(key, { limit: err.limit }) : t("context.refused.failed");
		},
		[t, i18n],
	);
}

/** Runs a decision, then reads again; the decision's error, or null. */
function useDecide(reload: () => Promise<void>) {
	const explain = useDecisionError();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const decide = async (id: string, work: () => Promise<void>) => {
		setBusy(id);
		setError(null);
		try {
			await work();
			await reload();
		} catch (err) {
			setError(explain(err));
		} finally {
			setBusy(null);
		}
	};
	return { busy, error, decide };
}

/** The brain's memories, the latest first, or ranked against what the person searches. */
export function MemoriesTab({ projectId }: { projectId: string }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const [typed, setTyped] = useState("");
	const [query, setQuery] = useState("");
	// Search once the person pauses typing, not at each letter.
	useEffect(() => {
		const timer = setTimeout(() => setQuery(typed.trim()), 400);
		return () => clearTimeout(timer);
	}, [typed]);
	const load = useCallback(() => api.memories(projectId, query), [api, projectId, query]);
	const { data, error, loading, refreshing, reload, refresh } = useLoad(load);
	const { busy, error: decisionError, decide } = useDecide(refresh);
	const writer = can("insight.write");

	const forget = (memory: Memory) =>
		Alert.alert(t("context.forgetTitle"), t("context.forgetBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("context.forget"),
				style: "destructive",
				onPress: () => void decide(memory.id, () => api.forgetMemory(projectId, memory.id, "")),
			},
		]);

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Field
				label={t("context.search")}
				value={typed}
				onChangeText={setTyped}
				maxLength={500}
				autoCapitalize="none"
				returnKeyType="search"
			/>
			<ErrorBanner error={error} />
			<ErrorBanner message={decisionError} />
			{loading && !data ? (
				<Loading />
			) : !data?.available ? (
				<Text style={{ color: theme.textMuted }}>{t("context.noBrain")}</Text>
			) : !data.memories.length ? (
				<Text style={{ color: theme.textMuted }}>{query ? t("context.noMatch") : t("context.noMemories")}</Text>
			) : (
				data.memories.map((m) => (
					<View key={m.id} style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<View style={styles.head}>
							<Text style={{ color: theme.textFaint, fontSize: 12, flex: 1 }}>
								{[
									i18n.exists(`context.memoryType.${m.type}`) ? t(`context.memoryType.${m.type}`) : m.type,
									m.timestamp ? formatDate(m.timestamp, i18n.language) : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</Text>
							{m.pinned ? <Chip icon="bookmark" label={t("context.pinned")} color={theme.accent} /> : null}
						</View>
						<Text style={{ color: theme.text, lineHeight: 21 }} selectable numberOfLines={12}>
							{m.content}
						</Text>
						{writer && m.id ? (
							<View style={styles.actions}>
								<Button
									label={m.pinned ? t("context.unpin") : t("context.pin")}
									icon="bookmark"
									variant="ghost"
									busy={busy === m.id}
									disabled={busy !== null}
									onPress={() => void decide(m.id, () => api.pinMemory(projectId, m.id, !m.pinned))}
								/>
								{m.pinned ? null : (
									<Button
										label={t("context.forget")}
										icon="trash-2"
										variant="ghost"
										disabled={busy !== null}
										onPress={() => forget(m)}
									/>
								)}
							</View>
						) : null}
					</View>
				))
			)}
		</ScrollView>
	);
}

/** The forgotten memories, the soonest purged first, and putting one back. */
export function TrashTab({ projectId }: { projectId: string }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const load = useCallback(() => api.memoryLifecycle(projectId), [api, projectId]);
	const { data, error, loading, refreshing, reload, refresh } = useLoad(load);
	const { busy, error: decisionError, decide } = useDecide(refresh);
	if (loading && !data) return <Loading />;
	const trash = data?.success ? (data.trash ?? []) : null;
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner error={error} />
			<ErrorBanner message={decisionError} />
			{data?.success ? (
				<Text style={[TYPE.small, { color: theme.textMuted }]}>
					{t("context.trashHint", {
						days: data.retention_days ?? 0,
						pinned: data.pinned ?? 0,
						limit: data.pin_limit ?? 0,
					})}
				</Text>
			) : null}
			{trash === null ? (
				data ? (
					<Text style={{ color: theme.textMuted }}>{t("context.noBrain")}</Text>
				) : null
			) : trash.length === 0 ? (
				<EmptyState icon="trash-2" title={t("context.trashEmpty")} />
			) : (
				trash.map((memory) => (
					<Forgotten
						key={memory.id}
						memory={memory}
						language={i18n.language}
						busy={busy === memory.id}
						disabled={busy !== null}
						onRestore={
							can("insight.write")
								? () => void decide(memory.id, () => api.restoreMemory(projectId, memory.id))
								: undefined
						}
					/>
				))
			)}
		</ScrollView>
	);
}

function Forgotten({
	memory,
	language,
	busy,
	disabled,
	onRestore,
}: {
	memory: ForgottenMemory;
	language: string;
	busy: boolean;
	disabled: boolean;
	onRestore?: () => void;
}) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			{memory.title ? <Text style={{ color: theme.text, fontWeight: "600" }}>{memory.title}</Text> : null}
			<Text style={{ color: theme.textMuted, lineHeight: 20 }} numberOfLines={6} selectable>
				{memory.preview}
			</Text>
			<Text style={[TYPE.caption, { color: theme.textFaint }]}>
				{memory.forgotten_by
					? t("context.forgottenBy", { name: memory.forgotten_by, date: formatDate(memory.forgotten_at, language) })
					: t("context.forgottenOn", { date: formatDate(memory.forgotten_at, language) })}
			</Text>
			<Text style={[TYPE.caption, { color: memory.expiring_soon ? theme.warning : theme.textFaint }]}>
				{t("context.restorableUntil", { date: formatDate(memory.restore_until, language) })}
			</Text>
			{onRestore ? (
				<Button
					label={t("context.restore")}
					icon="rotate-ccw"
					variant="secondary"
					busy={busy}
					disabled={disabled}
					onPress={onRestore}
				/>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
	head: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	actions: { flexDirection: "row", gap: SPACE.sm, flexWrap: "wrap" },
});
