/**
 * A card's approval on the server: how critical it is (which sets how many
 * people approve it), how many approvals it has, who gave them, and the roles
 * still missing. A person who may approve changes the criticality here; the
 * server decides whether they may (`shared_board/approvals.py`) and answers
 * with the approval as it then stands.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CRITICALITIES, type CardApproval, type Criticality } from "../api/types";
import { useApi, useSession } from "../auth/session";
import { describeError } from "../i18n";
import { ErrorBanner, Section } from "../ui/components";
import { formatDate } from "../ui/format";
import { RADIUS, SPACE, useTheme } from "../ui/theme";

export function ApprovalSection({
	projectId,
	cardId,
	fallback,
}: {
	projectId: string;
	cardId: string;
	/** What the card's details say, shown while the server's approval is not read (an older server). */
	fallback: string;
}) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const { can } = useSession();
	const [approval, setApproval] = useState<CardApproval | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setApproval(await api.approvals(projectId, cardId));
		} catch {
			// An older server has no such route: the card's own line says enough.
			setApproval(null);
		}
	}, [api, projectId, cardId]);

	useEffect(() => {
		void load();
	}, [load]);

	const choose = async (level: Criticality) => {
		if (!approval || level === approval.criticality) return;
		setBusy(true);
		setError(null);
		try {
			setApproval(await api.setCriticality(projectId, cardId, level));
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	if (!approval) {
		return (
			<Section title={t("card.approval")}>
				<Text style={{ color: theme.textMuted }}>{fallback}</Text>
			</Section>
		);
	}
	const settable = can("review.approve");
	return (
		<Section title={t("card.approval")}>
			<Text style={{ color: approval.approved ? theme.success : theme.text }}>
				{t("approval.count", { given: approval.count, needed: approval.needed })}
			</Text>
			<View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t("approval.criticality")}>
				{CRITICALITIES.map((level) => {
					const selected = approval.criticality === level;
					return (
						<Pressable
							key={level}
							accessibilityRole="radio"
							accessibilityState={{ selected, disabled: !settable || busy }}
							disabled={!settable || busy}
							onPress={() => void choose(level)}
							style={[
								styles.chip,
								{
									borderColor: selected ? theme.accent : theme.border,
									backgroundColor: selected ? theme.elevated : theme.surface,
								},
							]}
						>
							<Text style={{ color: selected ? theme.accent : theme.textMuted, fontWeight: "600" }}>
								{t(`approval.levels.${level}`)}
							</Text>
						</Pressable>
					);
				})}
			</View>
			<Text style={{ color: theme.textFaint, fontSize: 12 }}>
				{t(`approval.sources.${approval.criticalitySource}`)}
			</Text>
			{approval.missingRoles.length ? (
				<Text style={{ color: theme.textMuted }}>
					{t("approval.missingRoles", { roles: approval.missingRoles.join(", ") })}
				</Text>
			) : null}
			{approval.approvals.map((entry) => (
				<Text key={`${entry.by}-${entry.at}`} style={{ color: theme.textMuted }}>
					{entry.for
						? t("approval.byFor", { by: entry.by, for: entry.for, at: formatDate(entry.at, i18n.language) })
						: t("approval.by", { by: entry.by, at: formatDate(entry.at, i18n.language) })}
				</Text>
			))}
			<ErrorBanner message={error} />
		</Section>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: "row", gap: SPACE.sm, flexWrap: "wrap" },
	chip: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs },
});
