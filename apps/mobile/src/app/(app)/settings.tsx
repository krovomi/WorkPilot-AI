import Constants from "expo-constants";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../auth/session";
import { describeError } from "../../i18n";
import { Button, ErrorBanner, Section } from "../../ui/components";
import { RADIUS, SPACE, useTheme } from "../../ui/theme";

export default function Settings() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { user, serverUrl, permissions, switchOrg, signOut } = useSession();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const choose = async (orgId: string) => {
		if (orgId === permissions?.org_id) return;
		setBusy(orgId);
		setError(null);
		try {
			await switchOrg(orgId);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setBusy(null);
		}
	};

	const organizations = permissions?.organizations ?? [];
	return (
		<ScrollView contentContainerStyle={styles.content}>
			<Section title={t("settings.account")}>
				<Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{user?.display_name}</Text>
				<Text style={{ color: theme.textMuted }}>{user?.email}</Text>
			</Section>
			<Section title={t("settings.server")}>
				<Text style={{ color: theme.text }} selectable>
					{serverUrl}
				</Text>
			</Section>
			{organizations.length > 0 ? (
				<Section title={t("settings.organization")}>
					{organizations.map((org) => {
						const selected = org.id === permissions?.org_id;
						return (
							<Pressable
								key={org.id}
								accessibilityRole="radio"
								accessibilityState={{ selected, busy: busy === org.id }}
								disabled={!!busy}
								onPress={() => void choose(org.id)}
								style={[
									styles.org,
									{
										borderColor: selected ? theme.accent : theme.border,
										backgroundColor: selected ? theme.accentSoft : "transparent",
									},
								]}
							>
								<View style={{ flex: 1 }}>
									<Text style={{ color: theme.text, fontWeight: "600" }}>{org.name}</Text>
									{org.my_role ? <Text style={{ color: theme.textMuted }}>{org.my_role}</Text> : null}
								</View>
								{selected ? <Text style={{ color: theme.accent }}>✓</Text> : null}
							</Pressable>
						);
					})}
				</Section>
			) : null}
			<ErrorBanner message={error} />
			<Button label={t("settings.signOut")} variant="danger" onPress={() => void signOut()} />
			<Text style={{ color: theme.textFaint, textAlign: "center" }}>
				{t("settings.version", { version: Constants.expoConfig?.version ?? "?" })}
			</Text>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.lg, gap: SPACE.lg },
	org: {
		flexDirection: "row",
		alignItems: "center",
		borderWidth: 1,
		borderRadius: RADIUS.md,
		padding: SPACE.md,
	},
});
