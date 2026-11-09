import {
	Activity,
	AlertTriangle,
	BarChart3,
	Brain,
	Building2,
	Calendar,
	Camera,
	CheckCircle,
	ClipboardCheck,
	Code,
	Database,
	Download,
	FileCode2,
	FileJson,
	FileText,
	FlaskConical,
	GitBranch,
	GitFork,
	GitMerge,
	GitPullRequest,
	Globe,
	HeartPulse,
	Languages,
	Layers,
	LayoutGrid,
	Leaf,
	Lightbulb,
	MessageSquare,
	Mic,
	Network,
	Radio,
	Rocket,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	Target,
	Terminal,
	TestTube,
	Trophy,
	UserCheck,
	Users,
	WandSparkles,
	WifiOff,
	Workflow,
	Wrench,
	Zap,
	type LucideIcon,
	Map as MapIcon,
} from "lucide-react";
import type { SidebarView } from "../Sidebar";
import { EXPERIMENTAL_VIEWS } from "./experimental-views";
import {
	getHub,
	type HubTabGates,
	isHubExperimental,
	SIDEBAR_HUBS,
	type SidebarHubId,
	shownHubTabs,
} from "./hubs";
import { showsView } from "./server-gates";

/**
 * What the left menu lists: its groups, their entries, and the forge and
 * administration entries added when they apply. The sidebar renders it, the
 * command palette searches it (`nav-index.ts`), and the activity centre names
 * a page from it, so a page renamed or moved here is renamed or moved
 * everywhere at once.
 */

export interface NavItem {
	id: SidebarView;
	labelKey: string;
	icon: LucideIcon;
	shortcut?: string;
	hub?: SidebarHubId; // the entry stands for this hub's tabs (`sidebar/hubs.ts`)
}

export function hubNavItem(id: SidebarHubId): NavItem {
	const hub = getHub(id);
	return { id: hub.tabs[0].view, labelKey: hub.labelKey, icon: hub.icon, hub: id };
}

/** The views a menu entry stands for: a hub's tabs, or its own view. */
export function itemViews(item: NavItem): SidebarView[] {
	return item.hub ? getHub(item.hub).tabs.map((tab) => tab.view) : [item.id];
}

/** A hub's tabs as menu entries, for the search and the shortcuts. */
export function hubTabItems(item: NavItem, gates: HubTabGates): NavItem[] {
	if (!item.hub) return [item];
	return shownHubTabs(getHub(item.hub), gates).map((tab) => ({ ...tab, id: tab.view }));
}

/** Whether a menu entry stands for this view. */
export function isOn(item: NavItem, view: SidebarView | null): boolean {
	return view !== null && itemViews(item).includes(view);
}

export function isItemExperimental(item: NavItem): boolean {
	return item.hub ? isHubExperimental(getHub(item.hub)) : EXPERIMENTAL_VIEWS.has(item.id);
}

export function itemShown(item: NavItem, gates: HubTabGates): boolean {
	if (item.hub) return shownHubTabs(getHub(item.hub), gates).length > 0;
	return !(gates.hideExperimental && isItemExperimental(item)) && showsView(item.id, gates.serverProject);
}

export interface NavGroup {
	id: string;
	labelKey: string;
	icon: LucideIcon;
	items: NavItem[];
	defaultExpanded?: boolean;
}

// Navigation groups organized by user intent
export const navGroups: readonly NavGroup[] = [
	{
		id: "workspace",
		labelKey: "navigation:groups.workspace",
		icon: Target,
		items: [
			{
				id: "kanban",
				labelKey: "navigation:items.kanban",
				icon: LayoutGrid,
				shortcut: "WK",
			},
			{
				id: "dashboard",
				labelKey: "navigation:items.dashboard",
				icon: BarChart3,
				shortcut: "WD",
			},
			{
				id: "mission-control",
				labelKey: "navigation:items.missionControl",
				icon: Rocket,
				shortcut: "WM",
			},
			hubNavItem("agent-history"),
			{
				id: "phase35-hub",
				labelKey: "navigation:items.phase35Hub",
				icon: Sparkles,
				shortcut: "WA",
			},
		],
		defaultExpanded: true,
	},
	{
		id: "agents",
		labelKey: "navigation:groups.agents",
		icon: Rocket,
		items: [
			{
				id: "terminals",
				labelKey: "navigation:items.terminals",
				icon: Terminal,
				shortcut: "TM",
			},
			{
				id: "pixel-office",
				labelKey: "navigation:items.pixelOffice",
				icon: Building2,
				shortcut: "PO",
			},
			{
				id: "self-healing",
				labelKey: "navigation:items.selfHealing",
				icon: HeartPulse,
				shortcut: "SE",
			},
			hubNavItem("arena"),
			{
				id: "repo-bench",
				labelKey: "navigation:items.repoBench",
				icon: FlaskConical,
				shortcut: "RB",
			},
			{
				id: "bounty-board",
				labelKey: "navigation:items.bountyBoard",
				icon: Trophy,
				shortcut: "BB",
			},
			{
				id: "agent-coach",
				labelKey: "navigation:items.agentCoach",
				icon: UserCheck,
				shortcut: "AC",
			},
			{
				id: "live-companion",
				labelKey: "navigation:items.liveCompanion",
				icon: Radio,
				shortcut: "LC",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "development",
		labelKey: "navigation:groups.development",
		icon: Code,
		items: [
			{
				id: "pair-programming",
				labelKey: "navigation:items.pairProgramming",
				icon: Users,
				shortcut: "PP",
			},
			{
				id: "code-review",
				labelKey: "navigation:items.codeReview",
				icon: FileCode2,
				shortcut: "CR",
			},
			hubNavItem("debt"),
			{
				id: "test-generation",
				labelKey: "navigation:items.testGeneration",
				icon: TestTube,
				shortcut: "TG",
			},
			{
				id: "code-playground",
				labelKey: "navigation:items.codePlayground",
				icon: Zap,
				shortcut: "CP",
			},
			{
				id: "visual-to-code",
				labelKey: "navigation:items.visualToCode",
				icon: WandSparkles,
				shortcut: "VC",
			},
			hubNavItem("docs"),
			hubNavItem("onboarding"),
			{
				id: "flaky-tests",
				labelKey: "navigation:items.flakyTests",
				icon: AlertTriangle,
				shortcut: "FT",
			},
			{
				id: "performance-profiler",
				labelKey: "navigation:items.performanceProfiler",
				icon: Activity,
				shortcut: "PF",
			},
			{
				id: "cross-language-translation",
				labelKey: "navigation:items.crossLanguageTranslation",
				icon: Languages,
				shortcut: "CX",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "explore",
		labelKey: "navigation:groups.explore",
		icon: Sparkles,
		items: [
			{
				id: "insights",
				labelKey: "navigation:items.insights",
				icon: Sparkles,
				shortcut: "IN",
			},
			hubNavItem("context"),
			{
				id: "architecture-visualizer",
				labelKey: "navigation:items.architectureVisualizer",
				icon: Network,
				shortcut: "AV",
			},
			{
				id: "ideation",
				labelKey: "navigation:items.ideation",
				icon: Lightbulb,
				shortcut: "ID",
			},
			{
				id: "learning-loop",
				labelKey: "navigation:items.learningLoop",
				icon: Brain,
				shortcut: "LL",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "git-integrations",
		labelKey: "navigation:groups.gitIntegrations",
		icon: GitFork,
		items: [
			{
				id: "worktrees",
				labelKey: "navigation:items.worktrees",
				icon: GitBranch,
				shortcut: "WT",
			},
			hubNavItem("git-history"),
			hubNavItem("git-impact"),
			{
				id: "cicd-triggers",
				labelKey: "navigation:items.cicdTriggers",
				icon: Workflow,
				shortcut: "CD",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "planning",
		labelKey: "navigation:groups.planning",
		icon: BarChart3,
		items: [
			{
				id: "roadmap",
				labelKey: "navigation:items.roadmap",
				icon: MapIcon,
				shortcut: "RM",
			},
			{
				id: "analytics",
				labelKey: "navigation:items.analytics",
				icon: Database,
				shortcut: "AN",
			},
			hubNavItem("costs"),
			{
				id: "spec-approval",
				labelKey: "navigation:items.specApproval",
				icon: ClipboardCheck,
				shortcut: "SA",
			},
			{
				id: "changelog",
				labelKey: "navigation:items.changelog",
				icon: FileText,
				shortcut: "CL",
			},
			{
				id: "release-coordinator",
				labelKey: "navigation:items.releaseCoordinator",
				icon: Calendar,
				shortcut: "RC",
			},
			{
				id: "carbon-profiler",
				labelKey: "navigation:items.carbonProfiler",
				icon: Leaf,
				shortcut: "CB",
			},
			{
				id: "env-snapshot",
				labelKey: "navigation:items.envSnapshot",
				icon: Camera,
				shortcut: "ES",
			},
		],
		defaultExpanded: false,
	},
	{
		id: "toolbox",
		labelKey: "navigation:groups.toolbox",
		icon: Wrench,
		items: [
			// One entry per tool family (F181, lot 3): the hubs open on tabs
			hubNavItem("mcp-tools"),
			hubNavItem("quality-security"),
			hubNavItem("accessibility-i18n"),
			hubNavItem("api"),
			hubNavItem("automation"),
			{
				id: "voice-control",
				labelKey: "navigation:items.voiceControl",
				icon: Mic,
				shortcut: "VO",
			},
			{
				id: "migration",
				labelKey: "navigation:items.migration",
				icon: Download,
				shortcut: "MG",
			},
			{
				id: "prompt-optimizer",
				labelKey: "navigation:items.promptOptimizer",
				icon: WandSparkles,
				shortcut: "PT",
			},
			{
				id: "offline-mode",
				labelKey: "navigation:items.offlineMode",
				icon: WifiOff,
				shortcut: "OF",
			},
			// Beta: shown in the Labo while they are; out of beta, they show here
			{
				id: "regression-guardian",
				labelKey: "navigation:items.regressionGuardian",
				icon: ShieldAlert,
				shortcut: "RG",
			},
			{
				id: "compliance",
				labelKey: "navigation:items.compliance",
				icon: CheckCircle,
				shortcut: "CO",
			},
			{
				id: "api-watcher",
				labelKey: "navigation:items.apiWatcher",
				icon: FileJson,
				shortcut: "AW",
			},
			{
				id: "notebook-agent",
				labelKey: "navigation:items.notebookAgent",
				icon: FileCode2,
				shortcut: "NB",
			},
			{
				id: "pipeline-generator",
				labelKey: "navigation:items.pipelineGenerator",
				icon: Layers,
				shortcut: "PG",
			},
			{
				id: "team-bot",
				labelKey: "navigation:items.teamBot",
				icon: MessageSquare,
				shortcut: "TT",
			},
		],
		defaultExpanded: false,
	},
];

// GitHub nav items shown when GitHub is enabled
// The administration console. Kept out of `navGroups` and appended only when
// the signed-in user can actually reach it: in local mode, and for a member
// with no administration permission, the entry would lead to a page that only
// explains why it is empty.
export const administrationNavGroup: NavGroup = {
	id: "administration",
	labelKey: "navigation:groups.administration",
	icon: ShieldCheck,
	items: [
		{
			id: "administration",
			labelKey: "navigation:items.administration",
			icon: ShieldCheck,
			shortcut: "AD",
		},
	],
};

export const githubNavItems: readonly NavItem[] = [
	{
		id: "github-issues",
		labelKey: "navigation:items.githubIssues",
		icon: Globe,
		shortcut: "GI",
	},
	{
		id: "github-prs",
		labelKey: "navigation:items.githubPRs",
		icon: GitPullRequest,
		shortcut: "GP",
	},
];

// GitLab nav items shown when GitLab is enabled
export const gitlabNavItems: readonly NavItem[] = [
	{
		id: "gitlab-issues",
		labelKey: "navigation:items.gitlabIssues",
		icon: Globe,
		shortcut: "LI",
	},
	{
		id: "gitlab-merge-requests",
		labelKey: "navigation:items.gitlabMRs",
		icon: GitMerge,
		shortcut: "LM",
	},
];

/**
 * How a menu entry is named, for anything outside the sidebar that has to say
 * which page it is talking about — the activity centre, its toasts.
 *
 * Built from the same arrays the sidebar renders, so a page renamed here is
 * renamed there too; a second hand-written table is how the two start
 * disagreeing.
 */
const NAV_LABEL_KEYS: Partial<Record<SidebarView, string>> = Object.fromEntries(
	[
		...navGroups.flatMap((group) => group.items),
		...githubNavItems,
		...gitlabNavItems,
		// A hub's entry has its first tab's id: the tab's own name wins.
		...SIDEBAR_HUBS.flatMap((hub) => hub.tabs.map((tab) => ({ ...tab, id: tab.view }))),
	].map((item) => [item.id, item.labelKey]),
);

export function navItemLabelKey(view: SidebarView): string | undefined {
	return NAV_LABEL_KEYS[view];
}
