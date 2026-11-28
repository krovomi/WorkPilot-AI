/**
 * The organization's ceilings (`/admin/quotas`): seats, projects, agents at
 * once and tokens a month, with their use now. An empty field is unlimited.
 * Only someone with `org.quota.write` changes them; the server checks again.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useAdminApi } from "../../../admin/api";
import { QuotaMeters } from "../../../admin/QuotaMeters";
import { draftOf, type QuotaDraft, quotaChanges } from "../../../admin/quota-draft";
import { QUOTA_LIMITS, type QuotaChanges } from "../../../admin/types";
import { useAction } from "../../../admin/useAction";
import { useSession } from "../../../auth/session";
import { useLoad } from "../../../hooks/useLoad";
import { Button, ErrorBanner, Field, Loading, Section } from "../../../ui/components";
import { SPACE, TYPE, useTheme } from "../../../ui/theme";

export default function Quotas() {
	const { t } = useTranslation();
	const theme = useTheme();
	const admin = useAdminApi();
	const { can } = useSession();
	const canWrite = can("org.quota.write");
	const load = useCallback(() => admin.quotas(), [admin]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	const [draft, setDraft] = useState<QuotaDraft | null>(null);
	const [hardStop, setHardStop] = useState(false);
	const [saved, setSaved] = useState(false);
	const action = useAction();

	useEffect(() => {
		if (!data) return;
		setDraft(draftOf(data));
		setHardStop(data.enforce_hard_stop);
	}, [data]);

	if ((loading && !data) || (data && !draft)) return <Loading />;
	const changes = data && draft ? quotaChanges(data, draft, hardStop) : null;
	const changed = !!changes && Object.keys(changes).length > 0;
	const save = async () => {
		setSaved(false);
		// The button is only enabled with valid changes.
		if (await action.run("save", () => admin.setQuotas(changes as QuotaChanges))) {
			await reload();
			setSaved(true);
		}
	};

	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<ErrorBanner message={action.error} error={error} />
			{data && draft ? (
				<>
					<Section title={t("admin.quotas.use")}>
						<QuotaMeters quota={data} />
					</Section>
					<Section title={t("admin.quotas.limitsTitle")}>
						<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("admin.quotas.hint")}</Text>
						{QUOTA_LIMITS.map(({ limit }) => (
							<Field
								key={limit}
								label={t(`admin.quotas.limits.${limit}`)}
								value={draft[limit]}
								editable={canWrite}
								keyboardType="number-pad"
								placeholder={t("admin.quotas.unlimited")}
								maxLength={13}
								onChangeText={(text) => {
									setSaved(false);
									setDraft({ ...draft, [limit]: text });
								}}
							/>
						))}
						<View style={styles.switch}>
							<Text style={{ color: theme.text, flex: 1 }}>{t("admin.quotas.hardStop")}</Text>
							<Switch
								accessibilityLabel={t("admin.quotas.hardStop")}
								value={hardStop}
								disabled={!canWrite}
								onValueChange={(on) => {
									setSaved(false);
									setHardStop(on);
								}}
							/>
						</View>
						<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("admin.quotas.hardStopHint")}</Text>
						{!changes ? <Text style={{ color: theme.danger }}>{t("admin.quotas.invalid")}</Text> : null}
						{saved ? <Text style={{ color: theme.success }}>{t("admin.quotas.saved")}</Text> : null}
						{canWrite ? (
							<Button
								label={t("admin.quotas.save")}
								busy={action.busy === "save"}
								disabled={!changed}
								onPress={() => void save()}
							/>
						) : (
							<Text style={[TYPE.small, { color: theme.textMuted }]}>{t("admin.quotas.readOnly")}</Text>
						)}
					</Section>
				</>
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	switch: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
});
