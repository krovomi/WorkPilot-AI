/** How close the organization is to each of its ceilings: used of the limit, or used with no limit. */

import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { count } from "../insights/Figures";
import { RADIUS, SPACE, type Theme, TYPE, useTheme } from "../ui/theme";
import { QUOTA_LIMITS, type Quota } from "./types";

/** The share of a limit used, 0 to 1, or null with no limit. A limit of 0 is full from the start. */
export function usedShare(used: number, limit: number | null): number | null {
	if (limit === null) return null;
	if (limit <= 0) return 1;
	return Math.min(1, Math.max(0, used / limit));
}

export function meterColor(theme: Theme, share: number): string {
	if (share >= 1) return theme.danger;
	if (share >= 0.8) return theme.warning;
	return theme.accent;
}

export function QuotaMeters({ quota }: { quota: Quota }) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const lang = i18n.language;
	return (
		<View style={{ gap: SPACE.md }}>
			{QUOTA_LIMITS.map(({ limit, used }) => {
				const max = quota[limit];
				const share = usedShare(quota[used], max);
				return (
					<View key={limit} style={{ gap: SPACE.xs }}>
						<View style={styles.line}>
							<Text style={{ color: theme.text, flex: 1 }}>{t(`admin.quotas.limits.${limit}`)}</Text>
							<Text style={[TYPE.small, { color: share !== null ? meterColor(theme, share) : theme.textMuted }]}>
								{max === null
									? t("admin.quotas.usedNoLimit", { used: count(quota[used], lang) })
									: t("admin.quotas.usedOf", { used: count(quota[used], lang), limit: count(max, lang) })}
							</Text>
						</View>
						{share !== null ? (
							<View
								accessible
								accessibilityRole="progressbar"
								accessibilityLabel={t("admin.quotas.meter", { name: t(`admin.quotas.limits.${limit}`) })}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={Math.round(share * 100)}
								style={[styles.track, { backgroundColor: theme.border }]}
							>
								<View style={[styles.fill, { width: `${share * 100}%`, backgroundColor: meterColor(theme, share) }]} />
							</View>
						) : null}
					</View>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	line: { flexDirection: "row", alignItems: "baseline", gap: SPACE.sm },
	track: { height: 6, borderRadius: RADIUS.sm, overflow: "hidden" },
	fill: { height: 6, borderRadius: RADIUS.sm },
});
