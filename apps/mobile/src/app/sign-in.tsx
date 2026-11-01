import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ServerClient } from "../api/client";
import { api } from "../api/endpoints";
import { normaliseServerUrl } from "../api/server-url";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field } from "../ui/components";
import { SPACE, useTheme } from "../ui/theme";

export default function SignIn() {
	const { t } = useTranslation();
	const theme = useTheme();
	const session = useSession();
	const [server, setServer] = useState(session.serverUrl ?? "");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		const url = normaliseServerUrl(server);
		if (!url.ok) {
			setError(t(url.reason === "insecure" ? "signIn.insecureUrl" : "signIn.invalidUrl"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const config = await api(new ServerClient({ baseUrl: url.url })).authConfig();
			if (!config.local_enabled) {
				setError(t("signIn.localDisabled"));
				return;
			}
			await session.signIn(url.url, email.trim(), password);
		} catch (err) {
			setError(t("signIn.failed", { message: describeError(err) }));
		} finally {
			setBusy(false);
		}
	};

	const ready = server.trim() && email.trim() && password;
	return (
		<SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
			<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View style={styles.header}>
						<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
							{t("signIn.title")}
						</Text>
						<Text style={{ color: theme.textMuted, fontSize: 16 }}>{t("signIn.subtitle")}</Text>
					</View>
					<Field
						label={t("signIn.server")}
						placeholder={t("signIn.serverPlaceholder")}
						value={server}
						onChangeText={setServer}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="url"
						textContentType="URL"
					/>
					<Field
						label={t("signIn.email")}
						value={email}
						onChangeText={setEmail}
						autoCapitalize="none"
						autoCorrect={false}
						keyboardType="email-address"
						textContentType="username"
						autoComplete="email"
					/>
					<Field
						label={t("signIn.password")}
						value={password}
						onChangeText={setPassword}
						secureTextEntry
						textContentType="password"
						autoComplete="password"
						onSubmitEditing={() => void submit()}
					/>
					<ErrorBanner message={error} />
					<Button label={t("signIn.submit")} busy={busy} disabled={!ready} onPress={() => void submit()} />
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.xl, gap: SPACE.lg, flexGrow: 1, justifyContent: "center" },
	header: { gap: SPACE.sm, marginBottom: SPACE.md },
	title: { fontSize: 32, fontWeight: "800" },
});
