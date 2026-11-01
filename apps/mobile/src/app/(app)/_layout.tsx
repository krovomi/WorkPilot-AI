import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { PushBridge } from "../../push/PushBridge";
import { useTheme } from "../../ui/theme";

export default function SignedInLayout() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<>
			<PushBridge />
			<Stack
				screenOptions={{
					headerStyle: { backgroundColor: theme.surface },
					headerTintColor: theme.text,
					headerShadowVisible: false,
					contentStyle: { backgroundColor: theme.background },
				}}
			>
				<Stack.Screen name="index" options={{ title: t("projects.title") }} />
				<Stack.Screen name="settings" options={{ title: t("settings.title") }} />
				<Stack.Screen name="projects/[projectId]/index" options={{ title: "" }} />
				<Stack.Screen
					name="projects/[projectId]/new"
					options={{ title: t("newCard.title"), presentation: "modal" }}
				/>
				<Stack.Screen name="projects/[projectId]/cards/[cardId]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/insights/index" options={{ title: t("features.insights") }} />
				<Stack.Screen name="projects/[projectId]/insights/[sessionId]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/roadmap" options={{ title: t("features.roadmap") }} />
				<Stack.Screen name="projects/[projectId]/ideas" options={{ title: t("features.ideas") }} />
			</Stack>
		</>
	);
}
