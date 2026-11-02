import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { LockGate } from "../../auth/LockGate";
import { PushBridge } from "../../push/PushBridge";
import { useTheme } from "../../ui/theme";

export default function SignedInLayout() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<LockGate>
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
				<Stack.Screen name="projects/[projectId]/context" options={{ title: t("features.context") }} />
				<Stack.Screen name="tokens" options={{ title: t("tokens.title") }} />
				<Stack.Screen name="admin/index" options={{ title: t("admin.title") }} />
				<Stack.Screen name="admin/members" options={{ title: t("admin.members.title") }} />
				<Stack.Screen name="admin/invitations" options={{ title: t("admin.invitations.title") }} />
				<Stack.Screen name="admin/groups/index" options={{ title: t("admin.groups.title") }} />
				<Stack.Screen name="admin/groups/[groupId]" options={{ title: "" }} />
				<Stack.Screen name="admin/roles/index" options={{ title: t("admin.roles.title") }} />
				<Stack.Screen name="admin/roles/[roleId]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/forge/index" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/dashboard" options={{ title: t("dashboard.title") }} />
				<Stack.Screen name="projects/[projectId]/sessions" options={{ title: t("dashboard.sessions") }} />
				<Stack.Screen name="projects/[projectId]/analyses/index" options={{ title: t("dashboard.analyses") }} />
				<Stack.Screen name="projects/[projectId]/analyses/[kind]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/forge/issues/[number]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/forge/pulls/[number]" options={{ title: "" }} />
			</Stack>
		</LockGate>
	);
}
