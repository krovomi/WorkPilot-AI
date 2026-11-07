/**
 * The person's own tokens on the server (GitHub, GitLab, Azure DevOps, Jira,
 * Linear): the server keeps them encrypted and uses them for the person's
 * forge and tracker calls. The phone sends a token once and never reads it
 * back: the server says only which ones are set.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SECRET_KINDS, type SecretKind } from "../../api/endpoints";
import { useApi } from "../../auth/session";
import { useLoad } from "../../hooks/useLoad";
import { describeError } from "../../i18n";
import { Button, ErrorBanner, Field, Loading } from "../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../ui/theme";

export default function Tokens() {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const load = useCallback(() => api.secretKinds(), [api]);
	const { data, error, loading, refreshing, reload } = useLoad(load);
	if (loading && !data) return <Loading />;
	const set = new Set(data ?? []);
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.accent} />}
		>
			<Text style={{ color: theme.textMuted, lineHeight: 21 }}>{t("tokens.intro")}</Text>
			<ErrorBanner message={error ? describeError(error) : null} />
			{SECRET_KINDS.map((kind) => (
				<TokenRow key={kind} kind={kind} isSet={set.has(kind)} onChanged={reload} />
			))}
		</ScrollView>
	);
}

function TokenRow({ kind, isSet, onChanged }: { kind: SecretKind; isSet: boolean; onChanged: () => Promise<void> }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const api = useApi();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = t(`tokens.kinds.${kind}`);

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
			setValue("");
			setEditing(false);
			await onChanged();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = () =>
		Alert.alert(t("tokens.removeTitle", { name }), t("tokens.removeBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{ text: t("tokens.remove"), style: "destructive", onPress: () => void run(() => api.deleteSecret(kind)) },
		]);

	return (
		<View style={[styles.row, { borderColor: theme.border, backgroundColor: theme.surface }]}>
			<View style={styles.line}>
				<Text style={{ color: theme.text, fontWeight: "600", flex: 1 }}>{name}</Text>
				<Text style={{ color: isSet ? theme.success : theme.textFaint }}>
					{isSet ? t("tokens.set") : t("tokens.notSet")}
				</Text>
			</View>
			<ErrorBanner message={error} />
			{editing ? (
				<>
					<Field
						label={t("tokens.value", { name })}
						value={value}
						onChangeText={setValue}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={4096}
					/>
					<View style={styles.line}>
						<View style={{ flex: 1 }}>
							<Button label={t("common.cancel")} variant="secondary" onPress={() => setEditing(false)} />
						</View>
						<View style={{ flex: 1 }}>
							<Button
								label={t("tokens.save")}
								busy={busy}
								disabled={!value.trim()}
								onPress={() => void run(() => api.setSecret(kind, value.trim()))}
							/>
						</View>
					</View>
				</>
			) : (
				<View style={styles.line}>
					<View style={{ flex: 1 }}>
						<Button
							label={isSet ? t("tokens.replace") : t("tokens.add")}
							variant="secondary"
							onPress={() => setEditing(true)}
						/>
					</View>
					{isSet ? (
						<View style={{ flex: 1 }}>
							<Button label={t("tokens.remove")} variant="danger" busy={busy} onPress={remove} />
						</View>
					) : null}
				</View>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl * 2 },
	row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm },
	line: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
});
