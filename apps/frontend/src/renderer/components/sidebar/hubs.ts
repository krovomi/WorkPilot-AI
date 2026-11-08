import {
	BookOpen,
	BookOpenCheck,
	Bug,
	Calculator,
	Code,
	Coins,
	FileText,
	Gauge,
	GitBranch,
	GitMerge,
	History,
	Puzzle,
	RotateCcw,
	Share2,
	Store,
	Swords,
	Target,
	Users,
	Wand2,
	type LucideIcon,
	Wrench,
} from "lucide-react";
import type { SidebarView } from "../Sidebar";
import { EXPERIMENTAL_VIEWS } from "./experimental-views";
import { type ServerForge, showsView } from "./server-gates";

/**
 * Views that answer the same question share one sidebar entry, a hub, and
 * become its tabs (lot R7). No view is removed: each keeps its `SidebarView`
 * id, so a deep link (command palette, activity centre, notification, a
 * pinned favourite, a saved active view) still lands on its page, which then
 * shows its hub's tabs above it.
 *
 * The entry's id is its first tab's view: pins, custom order and the server
 * gates already keyed on it keep working.
 */
export type SidebarHubId =
	| "agent-history"
	| "costs"
	| "mcp-tools"
	| "context"
	| "git-impact"
	| "git-history"
	| "docs"
	| "onboarding"
	| "debt"
	| "arena";

export interface HubTab {
	readonly view: SidebarView;
	readonly labelKey: string;
	readonly icon: LucideIcon;
	/** The two-letter sidebar shortcut the view had before it became a tab. */
	readonly shortcut?: string;
	/** A tool that opens as a dialog: its tab offers to open it. */
	readonly dialog?: true;
}

export interface SidebarHub {
	readonly id: SidebarHubId;
	readonly labelKey: string;
	readonly icon: LucideIcon;
	readonly tabs: readonly HubTab[];
}

function tab(
	view: SidebarView,
	key: string,
	icon: LucideIcon,
	shortcut?: string,
	dialog?: true,
): HubTab {
	return { view, labelKey: `navigation:items.${key}`, icon, shortcut, dialog };
}

export const SIDEBAR_HUBS: readonly SidebarHub[] = [
	{
		id: "agent-history",
		labelKey: "navigation:hubs.agentHistory",
		icon: History,
		tabs: [
			tab("session-history", "sessionHistory", History, "WS"),
			tab("agent-replay", "agentReplay", RotateCcw, "AR"),
			tab("agent-debugger", "agentDebugger", Bug, "AG"),
		],
	},
	{
		id: "costs",
		labelKey: "navigation:hubs.costs",
		icon: Coins,
		tabs: [
			tab("cost-estimator", "costEstimator", Coins, "CE"),
			tab("smart-estimation", "smartEstimation", Calculator, undefined, true),
		],
	},
	{
		id: "mcp-tools",
		labelKey: "navigation:hubs.mcpTools",
		icon: Wrench,
		tabs: [
			tab("agent-tools", "agentTools", Wrench, "AT"),
			tab("mcp-marketplace", "mcpMarketplace", Store, "MK"),
			tab("plugin-marketplace", "pluginMarketplace", Puzzle, "PM"),
		],
	},
	{
		id: "context",
		labelKey: "navigation:hubs.context",
		icon: BookOpen,
		tabs: [
			tab("context", "context", BookOpen, "CT"),
			tab("context-mesh", "contextMesh", Share2, "CM"),
			tab("context-aware-snippets", "contextAwareSnippets", Code, "CS", true),
		],
	},
	{
		id: "git-impact",
		labelKey: "navigation:hubs.gitImpact",
		icon: Target,
		tabs: [
			tab("blast-radius", "blastRadius", Target, "BR"),
			tab("conflict-predictor", "conflictPredictor", GitMerge, "CF", true),
		],
	},
	{
		id: "git-history",
		labelKey: "navigation:hubs.gitHistory",
		icon: GitBranch,
		tabs: [
			tab("git-surgeon", "gitSurgeon", GitBranch, "GU"),
			tab("natural-language-git", "naturalLanguageGit", GitBranch, "NG", true),
		],
	},
	{
		id: "docs",
		labelKey: "navigation:hubs.docs",
		icon: BookOpenCheck,
		tabs: [
			tab("documentation", "documentation", BookOpenCheck, "DC"),
			tab("doc-drift", "docDrift", FileText, "DD"),
		],
	},
	{
		id: "onboarding",
		labelKey: "navigation:hubs.onboarding",
		icon: BookOpen,
		tabs: [
			tab("onboarding-guide", "onboardingGuide", BookOpen, "OG"),
			tab("onboarding-agent", "onboardingAgent", BookOpen, "OA"),
		],
	},
	{
		id: "debt",
		labelKey: "navigation:hubs.debt",
		icon: Gauge,
		tabs: [
			tab("tech-debt", "techDebt", Gauge, "TD"),
			tab("refactoring", "refactoring", Wand2, "RF"),
		],
	},
	{
		id: "arena",
		labelKey: "navigation:hubs.arena",
		icon: Swords,
		tabs: [
			tab("consensus-arbiter", "consensusArbiter", Users, "CA"),
			tab("arena-mode", "arenaMode", Swords, "AM", true),
		],
	},
];

const HUB_BY_ID = new Map(SIDEBAR_HUBS.map((hub) => [hub.id, hub]));
const HUB_BY_VIEW = new Map<SidebarView, SidebarHub>(
	SIDEBAR_HUBS.flatMap((hub) => hub.tabs.map((t) => [t.view, hub] as const)),
);

export function getHub(id: SidebarHubId): SidebarHub {
	const hub = HUB_BY_ID.get(id);
	if (!hub) throw new Error(`unknown sidebar hub: ${id}`);
	return hub;
}

/** The hub a view is a tab of, if any. */
export function hubOfView(view: SidebarView): SidebarHub | undefined {
	return HUB_BY_VIEW.get(view);
}

/** The sidebar entry that stands for a view: its hub's, or its own. */
export function entryIdOfView(view: SidebarView): SidebarView {
	return hubOfView(view)?.tabs[0].view ?? view;
}

export interface HubTabGates {
	readonly serverProject: boolean;
	readonly forge?: ServerForge | null;
	readonly hideExperimental?: boolean;
}

/**
 * The tabs of a hub the user can reach: a server project offers only its
 * server views (`server-gates.ts`), and hiding the experimental views hides
 * their tabs too, except the one on screen.
 */
export function shownHubTabs(
	hub: SidebarHub,
	gates: HubTabGates,
	activeView?: SidebarView,
): HubTab[] {
	return hub.tabs.filter(
		(t) =>
			showsView(t.view, gates.serverProject, gates.forge ?? null) &&
			(t.view === activeView ||
				!(gates.hideExperimental && EXPERIMENTAL_VIEWS.has(t.view))),
	);
}

/** A hub entry is experimental only when every one of its tabs is. */
export function isHubExperimental(hub: SidebarHub): boolean {
	return hub.tabs.every((t) => EXPERIMENTAL_VIEWS.has(t.view));
}

// The last tab opened in each hub, for this session of the app (not saved:
// a new session opens each hub on its first tab).
const lastTabs = new Map<SidebarHubId, SidebarView>();

export function rememberHubTab(view: SidebarView): void {
	const hub = hubOfView(view);
	if (hub) lastTabs.set(hub.id, view);
}

/** Where a hub's sidebar entry leads: its last tab if still shown, else the first shown. */
export function hubEntryTarget(
	hub: SidebarHub,
	gates: HubTabGates,
): SidebarView | undefined {
	const shown = shownHubTabs(hub, gates);
	const last = lastTabs.get(hub.id);
	return shown.find((t) => t.view === last)?.view ?? shown[0]?.view;
}

/** For tests. */
export function forgetHubTabs(): void {
	lastTabs.clear();
}
