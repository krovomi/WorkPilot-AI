import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../ui/theme";

export default function SignedInLayout() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
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
		</Stack>
	);
}
