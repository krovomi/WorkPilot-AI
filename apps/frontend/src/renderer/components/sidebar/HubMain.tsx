import type { ReactNode } from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/stores/project-store";
import type { SidebarView } from "../Sidebar";
import { HubLauncher } from "./HubLauncher";
import { HubTabList, hubTabDomId } from "./HubTabList";
import { hubOfView, rememberHubTab, shownHubTabs } from "./hubs";
import { serverForge } from "./server-gates";
import { useSidebarPrefs } from "./use-sidebar-prefs";

const PANEL_ID = "sidebar-hub-panel";
const TAB_PREFIX = "sidebar-hub";

/** The view under a hub's tabs is their panel, named by its tab. */
function panelProps(view: SidebarView) {
	return {
		id: PANEL_ID,
		role: "tabpanel",
		"aria-labelledby": hubTabDomId(TAB_PREFIX, view),
	} as const;
}

interface HubMainProps {
	readonly activeView: SidebarView;
	readonly onSelectView: (view: SidebarView) => void;
	readonly children: ReactNode;
}

/**
 * The app's main area. When the view on screen is a tab of a hub
 * (`hubs.ts`), the hub's tabs sit above it and the view is their panel.
 *
 * The tree has the same shape with or without a hub, so entering one never
 * remounts what the main area keeps alive across views (the terminals).
 */
export function HubMain({ activeView, onSelectView, children }: HubMainProps) {
	const { t } = useTranslation(["navigation"]);
	const project = useProjectStore((s) =>
		s.projects.find((p) => p.id === s.selectedProjectId),
	);
	const { prefs } = useSidebarPrefs();
	const hub = hubOfView(activeView);

	useEffect(() => {
		rememberHubTab(activeView);
	}, [activeView]);

	const tabs = hub
		? shownHubTabs(
				hub,
				{
					serverProject: Boolean(project?.remote),
					forge: serverForge(project),
					hideExperimental: prefs.hideExperimental === true,
				},
				activeView,
			)
		: [];
	const showTabs = tabs.length > 1;
	const dialogTab = tabs.find((tab) => tab.view === activeView && tab.dialog);

	return (
		<main className="flex flex-1 flex-col overflow-hidden">
			{showTabs && hub && (
				<HubTabList
					label={t(hub.labelKey)}
					tabs={tabs.map((tab) => ({
						id: tab.view,
						label: t(tab.labelKey),
						icon: tab.icon,
					}))}
					selectedId={activeView}
					onSelect={(id) => onSelectView(id as SidebarView)}
					panelId={PANEL_ID}
					idPrefix={TAB_PREFIX}
				/>
			)}
			<div
				{...(showTabs ? panelProps(activeView) : {})}
				className={showTabs ? "min-h-0 flex-1 overflow-auto" : "min-h-0 flex-1 overflow-hidden"}
			>
				{dialogTab && <HubLauncher tab={dialogTab} />}
				{children}
			</div>
		</main>
	);
}
