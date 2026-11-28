/**
 * The organization's administrative history (`GET /admin/audit`), newest
 * first: who did what, when, under which sign-in. A line opens on its
 * details; its action filters the list. The addresses the server keeps for
 * each line are not shown on the phone.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { AUDIT_PAGE, useAdminApi } from "../../../admin/api";
import { auditDetails, loginMethodKey } from "../../../admin/audit";
import type { AuditEntry } from "../../../admin/types";
import { useLoad } from "../../../hooks/useLoad";
import { mono } from "../../../card/LongText";
import { Button, ErrorBanner, Loading } from "../../../ui/components";
import { formatDate } from "../../../ui/format";
import { EmptyState } from "../../../ui/kit";
import { RADIUS, SPACE, TYPE, useTheme } from "../../../ui/theme";

/** The server reads at most this many lines at once. */
const MAX_AUDIT = 500;

export default function Audit() {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const [action, setAction] = useState<string | null>(null);
	const [pages, setPages] = useState(1);
	const [open, setOpen] = useState<string | null>(null);
	const limit = Math.min(AUDIT_PAGE * pages, MAX_AUDIT);
	const load = useCallback(() => admin.audit({ action: action ?? undefined, limit }), [admin, action, limit]);
	const { data, error, loading, refreshing, reload } = useLoad(load);

	const filterBy = (next: string | null) => {
		setAction(next);
		setPages(1);
		setOpen(null);
	};

	if (loading && !data) return <Loading />;
	const entries = data ?? [];
	const more = entries.length >= limit && limit < MAX_AUDIT;
	return (
		<FlatList<AuditEntry>
			data={entries}
			keyExtractor={(entry) => entry.id}
			contentContainerStyle={styles.content}
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
			ListHeaderComponent={
				<View style={{ gap: SPACE.sm }}>
					<ErrorBanner error={error} />
					{action ? (
						<View style={styles.filter}>
							<Text style={[TYPE.small, { color: theme.textMuted, flex: 1 }]}>
								{t("admin.audit.only", { action })}
							</Text>
							<Button label={t("admin.audit.all")} icon="x" variant="ghost" onPress={() => filterBy(null)} />
						</View>
					) : null}
				</View>
			}
			ListEmptyComponent={<EmptyState icon="list" title={t("admin.audit.empty")} />}
			ListFooterComponent={
				more ? (
					<Button
						label={t("admin.audit.more")}
						variant="secondary"
						busy={loading}
						onPress={() => setPages((n) => n + 1)}
					/>
				) : undefined
			}
			renderItem={({ item: entry }) => {
				const expanded = open === entry.id;
				const method = entry.login_id ? loginMethodKey(entry.login_method) : null;
				return (
					<View style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}>
						<Pressable
							accessibilityRole="button"
							accessibilityState={{ expanded }}
							accessibilityHint={t("admin.audit.openHint")}
							onPress={() => setOpen(expanded ? null : entry.id)}
							style={{ gap: 2 }}
						>
							<Text style={[mono.text, { color: theme.text }]}>{entry.action}</Text>
							<Text style={[TYPE.small, { color: theme.textMuted }]}>
								{[
									entry.user_email ?? t("admin.audit.system"),
									formatDate(entry.created_at, i18n.language),
									method ? t(`admin.audit.methods.${method}`) : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</Text>
						</Pressable>
						{expanded ? (
							<View style={{ gap: SPACE.xs }}>
								{auditDetails(entry.payload).map(({ key, value }) => (
									<Text key={key} style={[TYPE.small, { color: theme.textMuted }]} selectable>
										<Text style={{ fontWeight: "600", color: theme.text }}>{key}</Text> {value}
									</Text>
								))}
								{action !== entry.action ? (
									<Button
										label={t("admin.audit.filter")}
										icon="filter"
										variant="ghost"
										onPress={() => filterBy(entry.action)}
									/>
								) : null}
							</View>
						) : null}
					</View>
				);
			}}
		/>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl * 2 },
	filter: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
});
