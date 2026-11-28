import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { LockGate } from "../../auth/LockGate";
import { PushBridge } from "../../push/PushBridge";
import { PageActivityBridge } from "../../usage/PageActivityBridge";
import { UsageNoticeGate } from "../../usage/UsageNoticeGate";
import { useTheme } from "../../ui/theme";

export default function SignedInLayout() {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<LockGate>
			<PushBridge />
			<PageActivityBridge />
			<UsageNoticeGate />
			<Stack
				screenOptions={{
					headerStyle: { backgroundColor: theme.surface },
					headerTintColor: theme.text,
					headerShadowVisible: false,
					headerTitleStyle: { fontWeight: "700" },
					headerBackButtonDisplayMode: "minimal",
					contentStyle: { backgroundColor: theme.background },
				}}
			>
				<Stack.Screen name="index" options={{ title: t("projects.title") }} />
				<Stack.Screen name="inbox" options={{ title: t("inbox.title") }} />
				<Stack.Screen name="settings" options={{ title: t("settings.title") }} />
				<Stack.Screen name="share" options={{ title: t("share.title") }} />
				<Stack.Screen name="projects/[projectId]/(tabs)" options={{ headerShown: false }} />
				<Stack.Screen
					name="projects/[projectId]/new"
					options={{ title: t("newCard.title"), presentation: "modal" }}
				/>
				<Stack.Screen name="projects/[projectId]/cards/[cardId]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/cards/[cardId]/logs" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/cards/[cardId]/files" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/cards/[cardId]/captures" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/insights/[sessionId]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/roadmap" options={{ title: t("features.roadmap") }} />
				<Stack.Screen name="projects/[projectId]/ideas" options={{ title: t("features.ideas") }} />
				<Stack.Screen name="projects/[projectId]/context" options={{ title: t("features.context") }} />
				<Stack.Screen name="needs-you" options={{ title: t("needsYou.title") }} />
				<Stack.Screen name="replays" options={{ title: t("replays.title") }} />
				<Stack.Screen name="projects/[projectId]/chat" options={{ title: t("chat.title") }} />
				<Stack.Screen name="projects/[projectId]/leaderboard" options={{ title: t("leaderboard.title") }} />
				<Stack.Screen name="tokens" options={{ title: t("tokens.title") }} />
				<Stack.Screen name="ai-accounts" options={{ title: t("aiAccounts.title") }} />
				<Stack.Screen name="my-usage" options={{ title: t("myUsage.title") }} />
				<Stack.Screen name="admin/index" options={{ title: t("admin.title") }} />
				<Stack.Screen name="admin/overview" options={{ title: t("admin.overview.title") }} />
				<Stack.Screen name="admin/members" options={{ title: t("admin.members.title") }} />
				<Stack.Screen name="admin/invitations" options={{ title: t("admin.invitations.title") }} />
				<Stack.Screen name="admin/groups/index" options={{ title: t("admin.groups.title") }} />
				<Stack.Screen name="admin/groups/[groupId]" options={{ title: "" }} />
				<Stack.Screen name="admin/roles/index" options={{ title: t("admin.roles.title") }} />
				<Stack.Screen name="admin/roles/[roleId]" options={{ title: "" }} />
				<Stack.Screen name="admin/sessions" options={{ title: t("admin.sessions.title") }} />
				<Stack.Screen name="admin/quotas" options={{ title: t("admin.quotas.title") }} />
				<Stack.Screen name="admin/audit" options={{ title: t("admin.audit.title") }} />
				<Stack.Screen name="projects/[projectId]/governance" options={{ title: t("features.governance") }} />
				<Stack.Screen name="projects/[projectId]/waves" options={{ title: t("features.waves") }} />
				<Stack.Screen name="projects/[projectId]/sessions" options={{ title: t("dashboard.sessions") }} />
				<Stack.Screen name="projects/[projectId]/analyses/index" options={{ title: t("dashboard.analyses") }} />
				<Stack.Screen name="projects/[projectId]/analyses/[kind]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/forge/issues/[number]" options={{ title: "" }} />
				<Stack.Screen name="projects/[projectId]/forge/pulls/[number]" options={{ title: "" }} />
			</Stack>
		</LockGate>
	);
}
