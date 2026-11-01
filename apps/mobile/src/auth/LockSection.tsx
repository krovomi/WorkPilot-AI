/**
 * The app lock's two settings, on the settings screen. Changing either asks
 * for the lock first: whoever holds an unlocked phone cannot turn it off,
 * and turning it on proves it works on this phone.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";
import { describeError } from "../i18n";
import { ErrorBanner, Section } from "../ui/components";
import { SPACE, useTheme } from "../ui/theme";
import { authenticate, type LockSettings } from "./lock";
import { useLock } from "./LockGate";

export function LockSection() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { settings, available, update } = useLock();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const change = async (key: keyof LockSettings, value: boolean) => {
		setBusy(true);
		setError(null);
		try {
			if (!(await authenticate(t("lock.actionPrompt"), t("common.cancel")))) return;
			await update({ ...settings, [key]: value });
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section title={t("lock.section")}>
			{available ? null : <Text style={{ color: theme.textMuted }}>{t("lock.unavailable")}</Text>}
			<View style={styles.row}>
				<View style={styles.label}>
					<Text style={{ color: theme.text }}>{t("lock.atLaunch")}</Text>
					<Text style={{ color: theme.textMuted, fontSize: 13 }}>{t("lock.atLaunchHint")}</Text>
				</View>
				<Switch
					accessibilityLabel={t("lock.atLaunch")}
					value={settings.atLaunch}
					disabled={!available || busy}
					onValueChange={(on) => void change("atLaunch", on)}
				/>
			</View>
			<View style={styles.row}>
				<Text style={[styles.label, { color: theme.text }]}>{t("lock.sensitive")}</Text>
				<Switch
					accessibilityLabel={t("lock.sensitive")}
					value={settings.sensitive}
					disabled={!available || busy}
					onValueChange={(on) => void change("sensitive", on)}
				/>
			</View>
			<ErrorBanner message={error} />
		</Section>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
	label: { flex: 1, gap: SPACE.xs },
});
