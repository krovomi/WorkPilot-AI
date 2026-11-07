import "../i18n";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../auth/session";
import { Button, Centered, Loading } from "../ui/components";
import { useTheme } from "../ui/theme";
import { ThemeProvider } from "../ui/ThemeProvider";

export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<SessionProvider>
				<ThemeProvider>
					<Root />
				</ThemeProvider>
			</SessionProvider>
		</SafeAreaProvider>
	);
}

function Root() {
	const { status } = useSession();
	const theme = useTheme();
	if (status === "loading") return <Loading />;
	if (status === "unreachable") return <Unreachable />;
	const signedIn = status === "signedIn";
	return (
		<>
			<StatusBar style={theme.dark ? "light" : "dark"} />
			<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}>
				<Stack.Protected guard={signedIn}>
					<Stack.Screen name="(app)" />
				</Stack.Protected>
				<Stack.Protected guard={!signedIn}>
					<Stack.Screen name="sign-in" />
				</Stack.Protected>
			</Stack>
		</>
	);
}

function Unreachable() {
	const { t } = useTranslation();
	const theme = useTheme();
	const { retry, signOut } = useSession();
	return (
		<Centered>
			<Text accessibilityRole="header" style={{ color: theme.text, fontSize: 22, fontWeight: "700" }}>
				{t("unreachable.title")}
			</Text>
			<Text style={{ color: theme.textMuted, textAlign: "center" }}>{t("unreachable.body")}</Text>
			<Button label={t("common.retry")} onPress={() => void retry()} style={{ alignSelf: "stretch" }} />
			<Button
				label={t("unreachable.signOut")}
				variant="secondary"
				onPress={() => void signOut()}
				style={{ alignSelf: "stretch" }}
			/>
		</Centered>
	);
}
