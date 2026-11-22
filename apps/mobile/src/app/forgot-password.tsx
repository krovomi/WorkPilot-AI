/**
 * "Forgot password?": ask the server for a reset link, then paste the link
 * (or its code) and choose the new password.
 *
 * A server that cannot send email says so, and the person asks an
 * administrator, who issues the link from the desktop app. The address is
 * checked like the sign-in screen's before anything is sent.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, ServerClient } from "../api/client";
import { api } from "../api/endpoints";
import { passwordReset, tokenOf } from "../api/password-reset";
import { normaliseServerUrl } from "../api/server-url";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { Button, ErrorBanner, Field, KeyboardAvoiding } from "../ui/components";
import { SPACE, useTheme } from "../ui/theme";

/** The server's own minimum (`server/auth/local.py`). */
const MIN_PASSWORD = 12;

type Step = "ask" | "set" | "done";

export default function ForgotPassword() {
	const { t } = useTranslation();
	const theme = useTheme();
	const session = useSession();
	const params = useLocalSearchParams<{ server?: string }>();
	const [server, setServer] = useState(params.server || session.serverUrl || "");
	const [step, setStep] = useState<Step>("ask");
	const [email, setEmail] = useState("");
	const [link, setLink] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	/** The checked address's client, or null after saying why it is refused. */
	const client = (): ServerClient | null => {
		const url = normaliseServerUrl(server);
		if (url.ok) return new ServerClient({ baseUrl: url.url });
		setError(t(url.reason === "insecure" ? "signIn.insecureUrl" : "signIn.invalidUrl"));
		return null;
	};

	const run = async (work: (to: ServerClient) => Promise<void>, refused: (err: unknown) => string) => {
		setError(null);
		setNote(null);
		const to = client();
		if (!to) return;
		setBusy(true);
		try {
			await work(to);
		} catch (err) {
			setError(refused(err));
		} finally {
			setBusy(false);
		}
	};

	const ask = () =>
		run(
			async (to) => {
				const config = await api(to).authConfig();
				if (!config.password_reset_by_email) {
					setNote(t("forgotPassword.noEmail"));
					return;
				}
				await passwordReset(to).request(email.trim());
				setNote(t("forgotPassword.sent"));
			},
			(err) => t("forgotPassword.failed", { message: describeError(err) }),
		);

	const token = tokenOf(link);
	const save = () =>
		run(
			async (to) => {
				// `token` is checked by the button's state.
				await passwordReset(to).confirm(token as string, password);
				setStep("done");
			},
			(err) =>
				err instanceof ApiError && err.status === 404
					? t("forgotPassword.invalidLink")
					: t("forgotPassword.failed", { message: describeError(err) }),
		);

	const back = () => (router.canGoBack() ? router.back() : router.replace("/sign-in"));
	const switchTo = (next: Step) => {
		setError(null);
		setNote(null);
		setStep(next);
	};

	const mismatch = !!confirm && confirm !== password;
	const canSave = !!token && password.length >= MIN_PASSWORD && password === confirm;
	return (
		<SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
			<KeyboardAvoiding>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<View style={styles.header}>
						<Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
							{t("forgotPassword.title")}
						</Text>
						<Text style={{ color: theme.textMuted, fontSize: 16 }}>
							{t(step === "set" ? "forgotPassword.setDescription" : "forgotPassword.askDescription")}
						</Text>
					</View>
					{step === "done" ? (
						<Text accessibilityLiveRegion="polite" style={{ color: theme.text, fontSize: 16 }}>
							{t("forgotPassword.done")}
						</Text>
					) : (
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
					)}
					{step === "ask" && (
						<>
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
							{note && (
								<Text accessibilityLiveRegion="polite" style={{ color: theme.text }}>
									{note}
								</Text>
							)}
							<ErrorBanner message={error} />
							<Button
								label={t("forgotPassword.send")}
								busy={busy}
								disabled={!server.trim() || !email.includes("@") || busy}
								onPress={() => void ask()}
							/>
							<Button
								label={t("forgotPassword.haveLink")}
								variant="secondary"
								onPress={() => switchTo("set")}
							/>
						</>
					)}
					{step === "set" && (
						<>
							<Field
								label={t("forgotPassword.link")}
								value={link}
								onChangeText={setLink}
								autoCapitalize="none"
								autoCorrect={false}
							/>
							<Field
								label={t("forgotPassword.newPassword")}
								value={password}
								onChangeText={setPassword}
								secureTextEntry
								textContentType="newPassword"
								autoComplete="new-password"
							/>
							<Field
								label={t("forgotPassword.confirm")}
								value={confirm}
								onChangeText={setConfirm}
								secureTextEntry
								textContentType="newPassword"
								autoComplete="new-password"
							/>
							<Text style={{ color: mismatch ? theme.danger : theme.textFaint }}>
								{t(mismatch ? "forgotPassword.mismatch" : "forgotPassword.minLength", {
									count: MIN_PASSWORD,
								})}
							</Text>
							<ErrorBanner message={error} />
							<Button
								label={t("forgotPassword.save")}
								busy={busy}
								disabled={!canSave || busy}
								onPress={() => void save()}
							/>
							<Button
								label={t("forgotPassword.needLink")}
								variant="secondary"
								onPress={() => switchTo("ask")}
							/>
						</>
					)}
					<Button
						label={t("forgotPassword.back")}
						variant={step === "done" ? "primary" : "secondary"}
						onPress={back}
					/>
				</ScrollView>
			</KeyboardAvoiding>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	content: { padding: SPACE.xl, gap: SPACE.lg, flexGrow: 1, justifyContent: "center" },
	header: { gap: SPACE.sm, marginBottom: SPACE.md },
	title: { fontSize: 28, fontWeight: "800" },
});
