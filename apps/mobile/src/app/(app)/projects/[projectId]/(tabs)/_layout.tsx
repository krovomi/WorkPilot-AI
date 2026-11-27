import { useLocalSearchParams, useRouter } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../../../../../auth/session";
import { forgeKind, useProject } from "../../../../../forge/useForge";
import { PAGE_ICONS, showsTab } from "../../../../../project/pages";
import { ProjectIdContext } from "../../../../../project/ProjectId";
import { Icon } from "../../../../../ui/Icon";
import { IconButton } from "../../../../../ui/kit";
import { useTheme } from "../../../../../ui/theme";

/**
 * A project's tabs: the board, Insights, the forge and the dashboard, then
 * "More" for the other pages. A tab the person's permissions would refuse is
 * hidden (`href: null`); a card, a session or a pull request opens above the
 * tabs, in the app's stack.
 */
export default function ProjectTabs() {
	const { projectId } = useLocalSearchParams<{ projectId: string }>();
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { can } = useSession();
	const project = useProject(projectId);
	const forge = forgeKind(project.data?.forge);
	// The forge's tab waits for the project to say it has none: unread (or unreadable), its page explains.
	const hasForge = !!forge || !project.data;
	// A bar tall enough for an icon over its label, above the home indicator.
	const bottom = useSafeAreaInsets().bottom;

	// Opened from a link, the tabs have nothing under them: back goes to the projects.
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const shown = (page: "insights" | "forge" | "dashboard") => (showsTab(page, can, hasForge) ? undefined : null);

	return (
		<ProjectIdContext.Provider value={projectId}>
		<Tabs
			screenOptions={{
				headerStyle: { backgroundColor: theme.surface },
				headerTintColor: theme.text,
				headerShadowVisible: false,
				headerTitleStyle: { fontWeight: "700" },
				headerLeft: () => <IconButton icon="chevron-left" label={t("nav.projects")} onPress={back} />,
				headerLeftContainerStyle: { paddingLeft: 4 },
				headerRightContainerStyle: { paddingRight: 4 },
				tabBarActiveTintColor: theme.accent,
				tabBarInactiveTintColor: theme.textMuted,
				tabBarStyle: {
					backgroundColor: theme.surface,
					borderTopColor: theme.border,
					height: 64 + bottom,
					paddingTop: 4,
					paddingBottom: bottom + 4,
				},
				tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontWeight: "600" },
				tabBarItemStyle: { gap: 2 },
				sceneStyle: { backgroundColor: theme.background },
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: t("nav.board"),
					tabBarIcon: ({ color, size }) => <Icon name={PAGE_ICONS.board} color={color} size={size} />,
				}}
			/>
			<Tabs.Screen
				name="insights"
				options={{
					title: t("features.insights"),
					href: shown("insights"),
					tabBarIcon: ({ color, size }) => <Icon name={PAGE_ICONS.insights} color={color} size={size} />,
				}}
			/>
			<Tabs.Screen
				name="forge"
				options={{
					title: forge ? t(`forge.${forge}`) : "",
					href: shown("forge"),
					tabBarIcon: ({ color, size }) => <Icon name={PAGE_ICONS.forge} color={color} size={size} />,
				}}
			/>
			<Tabs.Screen
				name="dashboard"
				options={{
					title: t("dashboard.title"),
					href: shown("dashboard"),
					tabBarIcon: ({ color, size }) => <Icon name={PAGE_ICONS.dashboard} color={color} size={size} />,
				}}
			/>
			<Tabs.Screen
				name="more"
				options={{
					title: t("nav.more"),
					tabBarIcon: ({ color, size }) => <Icon name={PAGE_ICONS.more} color={color} size={size} />,
				}}
			/>
		</Tabs>
		</ProjectIdContext.Provider>
	);
}
