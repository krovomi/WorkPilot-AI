// React

// Types
import type { GitStatus } from "@shared/types";
// Drag and drop (dnd-kit)
import {
	type CollisionDetection,
	closestCenter,
	DndContext,
	DragOverlay,
	pointerWithin,
} from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
// Icons
import {
	Compass,
	FlaskConical,
	HelpCircle,
	PanelLeft,
	PanelLeftClose,
	Plus,
	RefreshCcw,
	Search,
	Settings,
	Star,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
// i18n
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui";
// Utils
import { cn } from "@/lib/utils";
import {
	clearProjectEnvConfig,
	loadProjectEnvConfig,
	useProjectEnvStore,
} from "@/stores/project-env-store";
// Stores
import { useProjectStore } from "@/stores/project-store";
import {
	selectGroupBadge,
	useActivityStore,
	useAttentionView,
} from "@/stores/activity-store";
import { saveSettings, useSettingsStore } from "@/stores/settings-store";
import { useSetupHubStore } from "@/stores/setup-hub-store";
// Modals & Components
import { AppEmulatorDialog } from "./app-emulator/AppEmulatorDialog";
import { ArenaDialog } from "./arena/ArenaDialog";
import { CodePlaygroundDialog } from "./code-playground/CodePlaygroundDialog";
import { ConflictPredictorDialog } from "./conflict-predictor/ConflictPredictorDialog";
import { ContextAwareSnippetsDialog } from "./context-aware-snippets/ContextAwareSnippetsDialog";
import { DependencySentinelDialog } from "./dependency-sentinel/DependencySentinelDialog";
import { GitSetupModal } from "./GitSetupModal";
import { LearningLoopDialog } from "./learning-loop/LearningLoopDialog";
import { NaturalLanguageGitDialog } from "./natural-language-git/NaturalLanguageGitDialog";
import { PromptOptimizerDialog } from "./prompt-optimizer/PromptOptimizerDialog";
import { RateLimitIndicator } from "./RateLimitIndicator";
import { SmartEstimationDialog } from "./smart-estimation/SmartEstimationDialog";
import { TestGenerationDialog } from "./test-generation/TestGenerationDialog";
import { SecureStorageBanner } from "./SecureStorageBanner";
import { UpdateBanner } from "./UpdateBanner";
// UI
import { Button } from "./ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";
import {
	encodeSortableId,
	SortableWrapper,
} from "./sidebar/sortable-primitives";
import {
	applyMenuLayout,
	hasCustomOrder,
	moveGroupBy,
	moveItemBy,
	moveItemToGroup,
	movePinBy,
} from "./sidebar/menu-layout";
import { CustomizeBar, CustomizeMenuToggle, RowMoveControls } from "./sidebar/MenuCustomizer";
import { useMenuDnd } from "./sidebar/use-menu-dnd";
import { ActivityBadge } from "./sidebar/ActivityBadge";
import { NavIcon, navLabelTitle } from "./sidebar/ExperimentalMarker";
import { EXPERIMENTAL_VIEWS } from "./sidebar/experimental-views";
import {
	entryIdOfView,
	getHub,
	type HubTabGates,
	hubEntryTarget,
} from "./sidebar/hubs";
import { serverForge, useServerNavGates } from "./sidebar/server-gates";
import { useSidebarPrefs } from "./sidebar/use-sidebar-prefs";
import { MenuModeCard } from "./sidebar/MenuModeCard";
import { SidebarResizeHandle } from "./sidebar/SidebarResizeHandle";
import { type RailSpace, SidebarRail } from "./sidebar/SidebarRail";
import { useSidebarResize } from "./sidebar/use-sidebar-resize";
import { HiddenList, HideSuggestion } from "./sidebar/HiddenPages";
import { LaboPanel } from "./sidebar/LaboPanel";
import {
	ESSENTIAL_VIEWS,
	LABO_SPACE,
	laboItemsOf,
	MINE_SPACE,
	railGroupsOf,
	UNUSED_DAYS,
	unusedEntries,
	recentNavItems,
	resolveSpace,
	spaceToFollow,
} from "./sidebar/spaces";
import { useViewUsageStore } from "@/stores/view-usage-store";
import { CliToolsChip } from "./sidebar/CliToolsChip";
import { StopAllAgentsButton } from "./sidebar/StopAllAgentsButton";
import { openNavView } from "./sidebar/nav-actions";
import { buildNavIndex, useNavIndexStore } from "./sidebar/nav-index";
import {
	administrationNavGroup,
	githubNavItems,
	gitlabNavItems,
	hubTabItems,
	isItemExperimental,
	isOn,
	itemShown,
	itemViews,
	type NavGroup,
	type NavItem,
	navGroups,
} from "./sidebar/nav-model";
import { openCommandPalette } from "@/stores/command-palette-store";
import { VoiceAssistant } from "./voice-assistant/VoiceAssistant";

export type SidebarView =
	| "kanban"
	| "terminals"
	| "roadmap"
	| "context"
	| "ideation"
	| "github-issues"
	| "gitlab-issues"
	| "github-prs"
	| "gitlab-merge-requests"
	| "changelog"
	| "insights"
	| "worktrees"
	| "agent-tools"
	| "migration"
	| "architecture-visualizer"
	| "performance-profiler"
	| "visual-to-code"
	| "dashboard"
	| "analytics"
	| "code-review"
	| "refactoring"
	| "documentation"
	| "cost-estimator"
	| "session-history"
	| "voice-control"
	| "test-generation"
	| "prompt-optimizer"
	| "code-playground"
	| "dependency-sentinel"
	| "natural-language-git"
	| "conflict-predictor"
	| "context-aware-snippets"
	| "app-emulator"
	| "learning-loop"
	| "mcp-marketplace"
	| "mission-control"
	| "agent-replay"
	| "pixel-office"
	| "self-healing"
	| "browser-agent"
	| "pair-programming"
	| "pipeline-generator"
	| "plugin-marketplace"
	| "arena-mode"
	| "api-explorer"
	| "sandbox"
	| "regression-guardian"
	| "injection-guard"
	| "api-watcher"
	| "accessibility-agent"
	| "i18n-agent"
	| "onboarding-agent"
	| "onboarding-guide"
	| "flaky-tests"
	| "doc-drift"
	| "compliance"
	| "git-surgeon"
	| "release-coordinator"
	| "carbon-profiler"
	| "consensus-arbiter"
	| "notebook-agent"
	| "agent-coach"
	| "bounty-board"
	| "repo-bench"
	| "tech-debt"
	| "agent-debugger"
	| "team-bot"
	| "blast-radius"
	| "guardrails"
	| "env-snapshot"
	| "offline-mode"
	| "cicd-triggers"
	| "cross-language-translation"
	| "spec-approval"
	| "live-companion"
	| "context-mesh"
	| "administration"
	| "phase35-hub"
	| "smart-estimation";

interface SidebarProps {
	readonly onSettingsClick: () => void;
	/** Opens the project's settings, where an uninitialized project is set up. */
	readonly onInitializeProject?: (projectId: string) => void;
	readonly onNewTaskClick: () => void;
	readonly activeView?: SidebarView;
	readonly onViewChange?: (view: SidebarView, force?: boolean) => void;
}

export { navItemLabelKey } from "./sidebar/nav-model";

/** A drag grip shows only while its row is hovered or focused, not on every row. */
/**
 * The star of the rail is small: the pointer over it wins, then the nearest
 * sortable row, so a page dragged onto the star pins it.
 */
/** The panel beside the rail, sized by the handle on its right edge. */
const SIDEBAR_PANEL_ID = "sidebar-panel";

const pointerFirst: CollisionDetection = (args) => {
	const within = pointerWithin(args);
	return within.length > 0 ? within : closestCenter(args);
};

const DRAG_SLOT_REVEAL =
	"[&>[data-drag-slot]]:opacity-0 [&>[data-drag-slot]]:transition-opacity [&:hover>[data-drag-slot]]:opacity-100 [&:focus-within>[data-drag-slot]]:opacity-100";

export function Sidebar({
	onSettingsClick,
	onInitializeProject,
	onNewTaskClick,
	activeView = "kanban",
	onViewChange,
}: SidebarProps) {
	const { t } = useTranslation(["navigation", "dialogs", "common"]);
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const settings = useSettingsStore((state) => state.settings);
	const openSetupHub = useSetupHubStore((state) => state.openSetupHub);

	// Read once for the whole sidebar: one subscription feeds every badge,
	// instead of one hook per menu entry over ~80 entries.
	const activities = useActivityStore((state) => state.activities);
	const attentionView = useAttentionView();
	const groupBadgeFor = useCallback(
		(items: NavItem[]) =>
			selectGroupBadge(
				activities,
				items.flatMap(itemViews),
				selectedProjectId,
			),
		[activities, selectedProjectId],
	);

	const [showGitSetupModal, setShowGitSetupModal] = useState(false);
	const gitSetupSkippedForProjectRef = useRef<string | null>(null);
	const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
	const {
		prefs: sidebarPrefs,
		toggleItemPin,
		unpinItems,
		toggleGroupPin,
		arrange,
		resetOrder,
		setHideExperimental,
		setActiveSpace,
		chooseMenuMode,
		hideItems,
		unhideItem,
		snoozeHideSuggestions,
		reset: resetSidebarPrefs,
	} = useSidebarPrefs();
	const pinnedItemsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedItems),
		[sidebarPrefs.pinnedItems],
	);
	const pinnedGroupsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedGroups),
		[sidebarPrefs.pinnedGroups],
	);
	// « Personnaliser le menu »: grips always shown, and the same moves as
	// the drag offered as buttons (`sidebar/MenuCustomizer.tsx`).
	const [customizing, setCustomizing] = useState(false);
	const shortcutBufferRef = useRef<string>("");
	const shortcutBufferTimeRef = useRef<number>(0);

	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Sidebar collapsed state from settings
	const isCollapsed = settings.sidebarCollapsed ?? false;

	// Width of the menu: dragged or moved with the keyboard on its right edge.
	const resize = useSidebarResize({
		storedWidth: settings.sidebarWidth,
		isCollapsed,
		onCommit: saveSettings,
	});

	const toggleSidebar = () => {
		saveSettings({ sidebarCollapsed: !isCollapsed });
	};

	// Subscribe to project-env-store for reactive GitHub/GitLab tab visibility
	const envGitHub = useProjectEnvStore((state) => state.envConfig?.githubEnabled ?? false);
	const envGitLab = useProjectEnvStore((state) => state.envConfig?.gitlabEnabled ?? false);

	// Server mode: the administration console, and the views a server project
	// offers (`sidebar/server-gates.ts`), its forge's (GitHub or GitLab) among them.
	const { canAdminister, serverProject } = useServerNavGates(
		selectedProject,
		activeView,
		onViewChange,
	);
	const forge = serverForge(selectedProject);
	const githubEnabled = serverProject ? forge === "github" : envGitHub;
	const gitlabEnabled = serverProject ? forge === "gitlab" : envGitLab;

	// Track the last loaded project ID to avoid redundant loads
	const lastLoadedProjectIdRef = useRef<string | null>(null);

	// The groups the code ships, with the forge's entries and the
	// administration when they apply, without the entries the gates hide
	// (experimental views the user hid, views a server project lacks)…
	const shippedNavGroups = useMemo(() => {
		const groups = navGroups.map((g) => ({ ...g, items: [...g.items] }));

		const integrationGroup = groups.find((g) => g.id === "git-integrations");
		if (integrationGroup) {
			if (githubEnabled) {
				integrationGroup.items.push(...githubNavItems);
			}
			if (gitlabEnabled) {
				integrationGroup.items.push(...gitlabNavItems);
			}
		}

		if (canAdminister) {
			groups.push({ ...administrationNavGroup, items: [...administrationNavGroup.items] });
		}

		const gates = { serverProject, forge, hideExperimental: sidebarPrefs.hideExperimental === true };
		return groups
			.map((group) => ({ ...group, items: group.items.filter((i) => itemShown(i, gates)) }))
			.filter((group) => group.items.length > 0);
	}, [
		sidebarPrefs.hideExperimental,
		githubEnabled,
		gitlabEnabled,
		canAdminister,
		serverProject,
		forge,
	]);

	// …then arranged as the user arranged them (`sidebar/menu-layout.ts`):
	// pages moved to another space, spaces and pages in their order. An id the
	// code no longer ships is dropped, a new one keeps its shipped place, so a
	// new menu entry needs no settings migration.
	const visibleNavGroups = useMemo(
		() =>
			applyMenuLayout(shippedNavGroups, {
				groupOrder: sidebarPrefs.groupOrder,
				itemOrder: sidebarPrefs.itemOrder,
				itemGroups: sidebarPrefs.itemGroups,
			}),
		[shippedNavGroups, sidebarPrefs.groupOrder, sidebarPrefs.itemOrder, sidebarPrefs.itemGroups],
	);

	// Build the synthetic "Favorites" group from pinned items and pinned groups.
	// Pinned groups contribute all their items; pinned standalone items are added
	// in their pin order. Dedup preserves pin order so "first pinned, first shown".
	const favoritesGroup = useMemo<NavGroup | null>(() => {
		const allItems = visibleNavGroups.flatMap((g) => g.items);
		const itemById = new Map(allItems.map((i) => [i.id, i]));

		const collected: NavItem[] = [];
		const seen = new Set<string>();

		for (const groupId of sidebarPrefs.pinnedGroups) {
			const group = visibleNavGroups.find((g) => g.id === groupId);
			if (!group) continue;
			for (const item of group.items) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				collected.push(item);
			}
		}
		for (const itemId of sidebarPrefs.pinnedItems) {
			const item = itemById.get(entryIdOfView(itemId as SidebarView));
			if (!item || seen.has(item.id)) continue;
			seen.add(item.id);
			collected.push(item);
		}

		if (collected.length === 0) return null;

		return {
			id: "__favorites__",
			labelKey: "navigation:groups.favorites",
			icon: Star,
			items: collected,
			defaultExpanded: true,
		};
	}, [
		visibleNavGroups,
		sidebarPrefs.pinnedGroups,
		sidebarPrefs.pinnedItems,
	]);

	// The tabs a hub's entry leads to, under the same gates as the entries
	const hubGates = useMemo<HubTabGates>(
		() => ({ serverProject, forge, hideExperimental: sidebarPrefs.hideExperimental === true }),
		[serverProject, forge, sidebarPrefs.hideExperimental],
	);

	// Get all visible items for keyboard shortcuts; a hub's tabs keep theirs
	const visibleNavItems = useMemo(() => {
		return visibleNavGroups.flatMap((group) =>
			group.items.flatMap((item) => hubTabItems(item, hubGates)),
		);
	}, [visibleNavGroups, hubGates]);

	// The pages shown, for the command palette: one list for both
	const setNavIndex = useNavIndexStore((state) => state.setEntries);
	useEffect(() => {
		setNavIndex(buildNavIndex(visibleNavGroups, hubGates));
	}, [visibleNavGroups, hubGates, setNavIndex]);

	// Load envConfig when project changes to ensure store is populated
	useEffect(() => {
		// Track whether this effect is still current (for race condition handling)
		let isCurrent = true;

		const initializeEnvConfig = async () => {
			if (selectedProject?.id && selectedProject?.autoBuildPath) {
				// Only reload if the project ID differs from what we last loaded
				if (selectedProject.id !== lastLoadedProjectIdRef.current) {
					lastLoadedProjectIdRef.current = selectedProject.id;
					await loadProjectEnvConfig(selectedProject.id);
					// Check if this effect was cancelled while loading
					if (!isCurrent) return;
				}
			} else {
				// Clear the store if no project is selected or has no autoBuildPath
				lastLoadedProjectIdRef.current = null;
				clearProjectEnvConfig();
			}
		};
		initializeEnvConfig();

		// Cleanup function to mark this effect as stale
		return () => {
			isCurrent = false;
		};
	}, [selectedProject?.id, selectedProject?.autoBuildPath]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't trigger shortcuts when typing in inputs
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement ||
				e.target instanceof HTMLSelectElement ||
				(e.target as HTMLElement)?.isContentEditable
			) {
				return;
			}

			// Only handle shortcuts when a project is selected
			if (!selectedProjectId) return;

			// Check for modifier keys - we want plain key presses only
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			// "/" opens the search: the command palette, which lists every page
			if (e.key === "/") {
				e.preventDefault();
				openCommandPalette();
				return;
			}

			// Ignore non-letter keys for 2-char shortcuts
			if (!/^[A-Za-z]$/.test(e.key)) return;

			const key = e.key.toUpperCase();
			const now = Date.now();
			const SHORTCUT_WINDOW_MS = 1000;

			const prefix = shortcutBufferRef.current;
			const prefixAge = now - shortcutBufferTimeRef.current;

			// If a recent prefix exists, try to match the full 2-char combo
			if (prefix && prefixAge <= SHORTCUT_WINDOW_MS) {
				const combo = prefix + key;
				const matched = visibleNavItems.find((item) => item.shortcut === combo);
				shortcutBufferRef.current = "";
				shortcutBufferTimeRef.current = 0;
				if (matched) {
					e.preventDefault();
					onViewChange?.(matched.id);
					return;
				}
				// Fall through to treat current key as a new prefix
			}

			// Check if this letter is a known prefix (first letter of any shortcut)
			const isPrefix = visibleNavItems.some(
				(item) => item.shortcut?.length === 2 && item.shortcut.startsWith(key),
			);
			if (isPrefix) {
				e.preventDefault();
				shortcutBufferRef.current = key;
				shortcutBufferTimeRef.current = now;
			}
			// Every shortcut has two letters (Sidebar.test.tsx checks it): a
			// letter that starts none does nothing.
		};

		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [selectedProjectId, onViewChange, visibleNavItems]);

	// Check git status when a project changes
	useEffect(() => {
		// Reset the skip flag when the project changes so the modal shows for new projects
		gitSetupSkippedForProjectRef.current = null;

		const checkGit = async () => {
			if (selectedProject) {
				try {
					const result = await globalThis.electronAPI.checkGitStatus(
						selectedProject.path,
					);
					if (result.success && result.data) {
						setGitStatus(result.data);
						// Git not ready and not dismissed. A project still to initialize is left to its
						// settings (opened on add, they repair git): a 2nd dialog on top closed them.
						if (
							(!result.data.isGitRepo || !result.data.hasCommits) && selectedProject.autoBuildPath &&
							gitSetupSkippedForProjectRef.current !== selectedProject.id
						) {
							setShowGitSetupModal(true);
						}
					}
				} catch (error) {
					console.error("Failed to check git status:", error);
				}
			} else {
				setGitStatus(null);
			}
		};
		checkGit();
	}, [selectedProject]);

	const handleGitInitialized = async () => {
		// Refresh git status after initialization
		if (selectedProject) {
			try {
				const result = await globalThis.electronAPI.checkGitStatus(
					selectedProject.path,
				);
				if (result.success && result.data) {
					setGitStatus(result.data);
				}
			} catch (error) {
				console.error("Failed to refresh git status:", error);
			}
		}
	};

	const handleNavClick = (view: SidebarView) => openNavView(view, onViewChange);

	const openNavItem = (item: NavItem) => {
		if (!item.hub) return handleNavClick(item.id);
		const target = hubEntryTarget(getHub(item.hub), hubGates);
		if (target) onViewChange?.(target);
	};

	const entryOfPin = useCallback((pin: string) => entryIdOfView(pin as SidebarView), []);
	const dnd = useMenuDnd({
		shipped: shippedNavGroups,
		arranged: visibleNavGroups,
		arrange,
		pinItem: (id) => {
			if (!pinnedItemsSet.has(id)) toggleItemPin(id);
		},
		pinGroup: (id) => {
			if (!pinnedGroupsSet.has(id)) toggleGroupPin(id);
		},
		entryOfPin,
	});

	// Where a page can be moved while customizing: every other space.
	const moveTargets = useMemo(
		() => shippedNavGroups.map((group) => ({ id: group.id, labelKey: group.labelKey })),
		[shippedNavGroups],
	);
	const ownPin = (item: NavItem) =>
		sidebarPrefs.pinnedItems.some((pin) => entryOfPin(pin) === item.id);

	// A row's controls while customizing, for a page of a space (`groupId`)
	// or a pin of « Mon menu » (no group); `shown` is the list on screen.
	const rowControls = (item: NavItem, shown: readonly string[], groupId: string | null) => {
		if (!customizing) return undefined;
		const at = shown.indexOf(item.id);
		if (at === -1) return undefined;
		const onMove = (delta: -1 | 1) =>
			arrange((current) => {
				if (groupId) return moveItemBy(current, visibleNavGroups, groupId, item.id, delta, shown);
				const pinnedItems = movePinBy(current.pinnedItems, entryOfPin, item.id, delta, shown);
				return pinnedItems ? { pinnedItems } : null;
			});
		return (
			<RowMoveControls
				name={t(item.labelKey)}
				canMoveUp={at > 0}
				canMoveDown={at < shown.length - 1}
				onMove={onMove}
				targets={groupId ? moveTargets.filter((target) => target.id !== groupId) : []}
				onMoveTo={
					groupId
						? (target) =>
								arrange((current) =>
									moveItemToGroup(current, shippedNavGroups, visibleNavGroups, item.id, target),
								)
						: undefined
				}
			/>
		);
	};

	// The two-letter shortcut lives in the hover title, not on every row
	const navItemTitle = (item: NavItem) => {
		const title = navLabelTitle(t, item.labelKey, isItemExperimental(item));
		return item.shortcut ? `${title} · ${item.shortcut}` : title;
	};

	const renderNavItem = (
		item: NavItem,
		context: "default" | "favorites" = "default",
		controls?: ReactNode,
	) => {
		const isActive = isOn(item, activeView);
		const Icon = item.icon;
		const isPinned = itemViews(item).some((view) => pinnedItemsSet.has(view));
		const badge = groupBadgeFor([item]);
		const hasAttention = isOn(item, attentionView);

		// Pin star lives OUTSIDE the nav button (nested <button> is invalid HTML).
		// It is an absolute overlay so the nav button keeps the full row width,
		// and only appears on hover/focus.
		const starButton =
			context === "favorites" || controls ? null : (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						if (isPinned && item.hub) unpinItems(itemViews(item));
						else toggleItemPin(item.id);
					}}
					aria-label={isPinned ? t("navigation:actions.unpin") : t("navigation:actions.pin")}
					aria-pressed={isPinned}
					className={cn(
						"absolute right-2 top-1/2 -translate-y-1/2 z-10",
						"flex items-center justify-center w-5 h-5 rounded",
						"transition-all duration-200",
						"hover:bg-accent/60 hover:scale-110",
						"opacity-0 group-hover/nav-item:opacity-100 focus-visible:opacity-100",
						isPinned ? "text-warning" : "text-muted-foreground/40 hover:text-warning",
					)}
				>
					<Star className={cn("h-3.5 w-3.5", isPinned && "fill-warning")} />
				</button>
			);

		return (
			<div key={item.id} className="group/nav-item relative flex items-center">
				<button
					type="button"
					onClick={() => openNavItem(item)}
					// The console is deployment-scoped, not project-scoped.
					disabled={!selectedProjectId && item.id !== "administration"}
					aria-keyshortcuts={item.shortcut}
					aria-current={isActive ? "page" : undefined}
					data-nav-item={item.id}
					className={cn(
						// pl-5 leaves room for the drag grip shown on hover
						"flex w-full min-w-0 items-center gap-3 rounded-md py-1.5 pr-3 pl-5 text-sm transition-colors",
						"hover:bg-accent hover:text-accent-foreground",
						"disabled:pointer-events-none disabled:opacity-50",
						isActive && "bg-primary/10 text-primary font-medium",
					)}
				>
					<NavIcon icon={Icon} experimental={isItemExperimental(item)} />
					<span className="flex-1 text-left truncate" title={navItemTitle(item)}>
						{t(item.labelKey)}
					</span>
					<ActivityBadge badge={badge} attention={hasAttention} />
				</button>
				{controls}
				{starButton}
			</div>
		);
	};

	const renderTooltipItem = (item: NavItem) => {
		const isActive = isOn(item, activeView);
		const badge = groupBadgeFor([item]);
		return (
			<button
				key={item.id}
				type="button"
				onClick={() => openNavItem(item)}
				disabled={!selectedProjectId && item.id !== "administration"}
				aria-keyshortcuts={item.shortcut}
				className={cn(
					"w-full flex items-center gap-2 text-xs p-1 rounded text-left",
					"hover:bg-accent hover:text-accent-foreground",
					"disabled:pointer-events-none disabled:opacity-50",
					isActive && "bg-accent text-accent-foreground",
				)}
			>
				<NavIcon icon={item.icon} experimental={isItemExperimental(item)} size="sm" />
				<span className="flex-1 truncate" title={navLabelTitle(t, item.labelKey, isItemExperimental(item))}>{t(item.labelKey)}</span>
				<ActivityBadge badge={badge} />
				{item.shortcut && (
					<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
						{item.shortcut}
					</kbd>
				)}
			</button>
		);
	};

	const renderTooltipItems = (items: NavItem[]) => items.map(renderTooltipItem);

	// A row of a space (`item:<id>`) or a pin of « Mon menu » (`pin:<id>`),
	// both sortable. A page « Mon menu » shows because its whole group is
	// pinned follows that group, so it has no grip of its own.
	const renderPanelRow = (
		item: NavItem,
		delay: number,
		context: "default" | "favorites",
		controls?: ReactNode,
	) => {
		const sortable = context === "default" || ownPin(item);
		return (
			<SortableWrapper
				key={item.id}
				sortableId={encodeSortableId(context === "favorites" ? "pin" : "item", item.id)}
				disabled={!sortable}
				revealed={customizing}
			>
				{({ setNodeRef, style, isDragging, dragHandle }) => (
					<div
						ref={setNodeRef}
						style={{ ...style, animationDelay: `${delay}ms` }}
						className={cn(
							"relative group animate-in slide-in-from-left-2 duration-200 ease-out",
							!customizing && DRAG_SLOT_REVEAL,
							isDragging &&
								"ring-1 ring-primary/50 rounded-lg bg-background/80 backdrop-blur",
						)}
					>
						{sortable && (
							<div data-drag-slot className="absolute left-1 top-1/2 -translate-y-1/2 z-10">
								{dragHandle}
							</div>
						)}
						{renderNavItem(item, context, controls)}
					</div>
				)}
			</SortableWrapper>
		);
	};

	// A section of a space, as a plain title instead of a box
	const sectionTitle = (key: string) => (
		<h3 className="px-3 pt-3 pb-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground/70">
			{t(key)}
		</h3>
	);

	const renderExpandedItems = (
		items: NavItem[],
		context: "default" | "favorites" = "default",
		groupId: string | null = null,
	) => {
		const kind = context === "favorites" ? "pin" : "item";
		const sortableIds = items.map((i) => encodeSortableId(kind, i.id));
		// The list the up and down buttons move through: a space's pages, or
		// the pins that are the user's own (a pinned group's pages follow it).
		const shown = (context === "favorites" ? items.filter(ownPin) : items).map((i) => i.id);
		return (
			<SortableContext
				items={sortableIds}
				strategy={verticalListSortingStrategy}
			>
				<div className="space-y-0.5">
					{items.map((item, index) =>
						renderPanelRow(item, index * 50, context, rowControls(item, shown, groupId)),
					)}
				</div>
			</SortableContext>
		);
	};

	// The rail (F181, lot 2): « Mon menu », then one space per group. The panel
	// beside it lists the chosen space only.
	const viewUsage = useViewUsageStore((state) => state.usage);
	const usageSince = useViewUsageStore((state) => state.since);
	const mineItems = favoritesGroup?.items ?? [];

	// The rail's groups lose their beta entries to the Labo and the entries
	// the user hid (lot 3); the lookups above keep every entry, so a pin, a
	// recent page or Ctrl K still reaches them.
	const hiddenSet = useMemo(() => new Set(sidebarPrefs.hiddenItems ?? []), [sidebarPrefs.hiddenItems]);
	const railGroups = useMemo(() => railGroupsOf(visibleNavGroups, hiddenSet), [visibleNavGroups, hiddenSet]);
	const laboItems = useMemo(() => laboItemsOf(visibleNavGroups, hubGates), [visibleNavGroups, hubGates]);
	const spaceGroups = useMemo<NavGroup[]>(
		() =>
			laboItems.length > 0
				? [...railGroups, { id: LABO_SPACE, labelKey: "navigation:spaces.labo", icon: FlaskConical, items: laboItems }]
				: railGroups,
		[railGroups, laboItems],
	);
	const recentItems = useMemo(
		() => recentNavItems(viewUsage, visibleNavGroups, pinnedItemsSet),
		[viewUsage, visibleNavGroups, pinnedItemsSet],
	);
	const showMenuModeCard = !sidebarPrefs.menuMode && mineItems.length === 0;
	const [chosenSpace, setChosenSpace] = useState(sidebarPrefs.activeSpace);
	const space = resolveSpace(
		chosenSpace,
		spaceGroups,
		mineItems.length > 0 || recentItems.length > 0 || showMenuModeCard,
		activeView,
	);

	// A page opened from the palette, a shortcut or a notification brings its
	// space into view, unless the space on screen already lists it.
	const followRef = useRef({ space, groups: spaceGroups, listed: [...mineItems, ...recentItems] });
	followRef.current = { space, groups: spaceGroups, listed: [...mineItems, ...recentItems] };
	// Only a change of page moves it: at start the space last chosen stays.
	const followedViewRef = useRef(activeView);
	useEffect(() => {
		if (followedViewRef.current === activeView) return;
		followedViewRef.current = activeView;
		const { space: current, groups, listed } = followRef.current;
		const next = spaceToFollow(current, groups, listed, activeView);
		if (next) setChosenSpace(next);
	}, [activeView]);

	// Choosing a space shows it; choosing the one shown folds the panel, and
	// any choice unfolds a folded panel.
	const selectSpace = (spaceId: string) => {
		if (!isCollapsed && spaceId === space) {
			saveSettings({ sidebarCollapsed: true });
			return;
		}
		setChosenSpace(spaceId);
		setActiveSpace(spaceId);
		if (isCollapsed) saveSettings({ sidebarCollapsed: false });
	};

	const spaceOf = (group: NavGroup): RailSpace => ({
		id: group.id,
		labelKey: group.labelKey,
		icon: group.icon,
		badge: groupBadgeFor(group.items),
		attention: group.items.some((item) => isOn(item, attentionView)),
		preview: renderTooltipItems(group.items),
	});
	const mineSpace: RailSpace = {
		id: MINE_SPACE,
		labelKey: "navigation:spaces.mine",
		icon: Star,
		badge: groupBadgeFor(mineItems),
		attention: mineItems.some((item) => isOn(item, attentionView)),
		preview: mineItems.length > 0 ? renderTooltipItems(mineItems) : undefined,
	};
	const laboSpace: RailSpace = {
		id: LABO_SPACE,
		labelKey: "navigation:spaces.labo",
		icon: FlaskConical,
		badge: groupBadgeFor(laboItems),
		attention: laboItems.some((item) => isOn(item, attentionView)),
		count: laboItems.length,
		preview: renderTooltipItems(laboItems),
	};
	const spaceGroup = spaceGroups.find((group) => group.id === space);

	// A space's pages nobody opened for a month, offered to hide, and the ones hidden
	const now = Date.now();
	const groupOfSpace = visibleNavGroups.find((group) => group.id === space);
	const unused =
		spaceGroup && space !== LABO_SPACE && (sidebarPrefs.hideSuggestionsSnoozedUntil ?? 0) < now
			? unusedEntries(spaceGroup.items, viewUsage, usageSince, now, pinnedItemsSet)
			: [];
	const hiddenHere = groupOfSpace?.items.filter((item) => hiddenSet.has(item.id)) ?? [];
	// The space's place in the rail, when it is a group the rail can reorder
	const spaceIndex = railGroups.findIndex((group) => group.id === space);
	const spaceTitle =
		space === MINE_SPACE ? t("navigation:spaces.mine") : spaceGroup ? t(spaceGroup.labelKey) : "";

	// « Mon menu »: the pages pinned, the pages opened last, and the first time
	// the choice between the essential menu and the full one.
	const renderMine = () => (
		<div className="space-y-1">
			{mineItems.length > 0 && (
				<section>
					{sectionTitle("navigation:spaces.pinned")}
					{renderExpandedItems(mineItems, "favorites")}
				</section>
			)}
			{recentItems.length > 0 && (
				<section>
					{sectionTitle("navigation:spaces.recent")}
					<div className="space-y-0.5">{recentItems.map((item) => renderNavItem(item))}</div>
				</section>
			)}
			{showMenuModeCard && (
				<div className="pt-2">
					<MenuModeCard
						essentialCount={ESSENTIAL_VIEWS.length}
						onChoose={(mode) => chooseMenuMode(mode, ESSENTIAL_VIEWS)}
					/>
				</div>
			)}
			{!showMenuModeCard && mineItems.length === 0 && recentItems.length === 0 && (
				<p className="px-3 py-4 text-xs text-muted-foreground">{t("navigation:spaces.mineEmpty")}</p>
			)}
		</div>
	);

	const layoutChanged =
		sidebarPrefs.pinnedItems.length > 0 ||
		sidebarPrefs.pinnedGroups.length > 0 ||
		sidebarPrefs.groupOrder.length > 0 ||
		Object.keys(sidebarPrefs.itemOrder).length > 0 ||
		Object.keys(sidebarPrefs.itemGroups ?? {}).length > 0 ||
		Boolean(sidebarPrefs.menuMode) ||
		(sidebarPrefs.hiddenItems?.length ?? 0) > 0;

	const railIconButton = (label: string, onClick: () => void, icon: ReactNode) => (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="ghost" size="icon" className="h-9 w-9" onClick={onClick} aria-label={label}>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);

	const railFooter = (
		<>
			{resize.folded &&
				railIconButton(t("actions.newTask"), () => {
					if (selectedProjectId && selectedProject?.autoBuildPath) onNewTaskClick();
				}, <Plus className="h-4 w-4" />)}
			<StopAllAgentsButton />
			<CliToolsChip
				isCollapsed
				onNavigateToTerminals={() => onViewChange?.("terminals", true)}
			/>
			{railIconButton(t("setupHub:title"), () => openSetupHub(), <Compass className="h-4 w-4" />)}
			{railIconButton(
				t("tooltips.help"),
				() => globalThis.open("https://github.com/krovomi/WorkPilot-AI/issues", "_blank"),
				<HelpCircle className="h-4 w-4" />,
			)}
			{railIconButton(t("tooltips.settings"), onSettingsClick, <Settings className="h-4 w-4" />)}
			{railIconButton(
				resize.folded ? t("actions.expandSidebar") : t("actions.collapseSidebar"),
				toggleSidebar,
				resize.folded ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />,
			)}
		</>
	);

	return (
		<TooltipProvider>
			<DndContext
				sensors={dnd.sensors}
				accessibility={dnd.accessibility}
				collisionDetection={pointerFirst}
				onDragStart={dnd.onDragStart}
				onDragEnd={dnd.onDragEnd}
				onDragCancel={dnd.onDragCancel}
			>
				<div
					className={cn(
						"relative flex h-full bg-sidebar border-r border-border",
						!resize.isResizing && "transition-[width] duration-300",
					)}
					style={{ width: resize.width }}
				>
					<SidebarRail
						mine={mineSpace}
						groups={railGroups.map(spaceOf)}
						extras={laboItems.length > 0 ? [laboSpace] : []}
						activeSpace={space}
						isCollapsed={resize.folded}
						onSelect={selectSpace}
						footer={railFooter}
					/>

					{!resize.folded && (
						<div
							id={SIDEBAR_PANEL_ID}
							className="flex min-w-0 flex-1 flex-col"
							data-testid="sidebar-panel"
						>
							{/* Header with drag area - extra top padding for macOS traffic lights */}
							<div className="electron-drag flex h-14 shrink-0 items-end px-4 pb-1.5">
								<h2 className="electron-no-drag truncate text-base font-semibold text-foreground">
									{spaceTitle}
								</h2>
							</div>

							{/* Search: the command palette, which lists every page */}
							<div className="px-3 py-2">
								<button
									type="button"
									onClick={openCommandPalette}
									title={t("search.openTooltip")}
									data-testid="sidebar-search"
									className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
								>
									<Search className="h-3.5 w-3.5 shrink-0" />
									<span className="flex-1 truncate text-left">{t("search.open")}</span>
									<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
										Ctrl K
									</kbd>
								</button>
							</div>

							<ScrollArea className="flex-1">
								<div className="px-2 pb-4">
									{customizing && (
										<CustomizeBar
											spaceName={spaceIndex === -1 ? null : spaceTitle}
											canMoveSpaceUp={spaceIndex > 0}
											canMoveSpaceDown={spaceIndex !== -1 && spaceIndex < railGroups.length - 1}
											onMoveSpace={(delta) =>
												arrange((current) =>
													moveGroupBy(current, visibleNavGroups, space, delta, railGroups.map((g) => g.id)),
												)
											}
											orderChanged={hasCustomOrder(sidebarPrefs)}
											onResetOrder={resetOrder}
											onDone={() => setCustomizing(false)}
										/>
									)}
									{space === MINE_SPACE
										? renderMine()
										: space === LABO_SPACE
											? (
												<LaboPanel
													items={laboItems}
													activeView={activeView}
													disabled={!selectedProjectId}
													onOpen={openNavItem}
												/>
											)
											: spaceGroup && renderExpandedItems(spaceGroup.items, "default", spaceGroup.id)}
									{unused.length > 0 && (
										<div className="mt-4">
											<HideSuggestion
												unused={unused}
												onHide={hideItems}
												onSnooze={() => snoozeHideSuggestions(Date.now() + UNUSED_DAYS * 24 * 60 * 60 * 1000)}
											/>
										</div>
									)}
									<div className="mt-4 space-y-1">
										<HiddenList hidden={hiddenHere} onShow={unhideItem} />
										<CustomizeMenuToggle
											customizing={customizing}
											onToggle={() => setCustomizing((value) => !value)}
										/>
										{layoutChanged && (
											<button
												type="button"
												onClick={resetSidebarPrefs}
												className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
											>
												<RefreshCcw className="h-3 w-3" />
												{t("navigation:actions.resetLayout")}
											</button>
										)}
										<button
											type="button"
											onClick={() => setHideExperimental(sidebarPrefs.hideExperimental !== true)}
											aria-pressed={sidebarPrefs.hideExperimental === true}
											className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
										>
											{sidebarPrefs.hideExperimental === true
												? t("navigation:experimental.show", { count: EXPERIMENTAL_VIEWS.size })
												: t("navigation:experimental.hide")}
										</button>
									</div>
								</div>
							</ScrollArea>

							{/* Rate Limit Indicator - shows when Claude is rate limited */}
							<RateLimitIndicator />
							{/* Update Banner - shows when app update is available */}
							<UpdateBanner />
							{/* API keys stored without the OS keyring (rule S1) */}
							<SecureStorageBanner />

							<div className="border-t border-border p-3">
								<Button
									className="w-full"
									onClick={onNewTaskClick}
									disabled={!selectedProjectId || !selectedProject?.autoBuildPath}
								>
									<Plus className="mr-2 h-4 w-4" />
									{t("actions.newTask")}
								</Button>
								{selectedProject && !selectedProject.autoBuildPath && (
									// A project added from an existing folder reaches its first
									// task through the pane that initializes it.
									<Button
										variant="link"
										size="sm"
										className="mt-1 h-auto w-full whitespace-normal text-xs text-muted-foreground"
										onClick={() => onInitializeProject?.(selectedProject.id)}
									>
										{t("messages.initializeToCreateTasks")}
									</Button>
								)}
							</div>
						</div>
					)}

					<SidebarResizeHandle
						controls={SIDEBAR_PANEL_ID}
						width={resize.width}
						maxWidth={resize.maxWidth}
						folded={resize.folded}
						isResizing={resize.isResizing}
						isDragging={resize.isDragging}
						{...resize.handlers}
					/>
				</div>
				<DragOverlay dropAnimation={null}>
					{dnd.activeDragId ? (
						<div className="rounded-lg bg-accent/80 backdrop-blur border border-primary/40 shadow-2xl px-3 py-2 text-sm">
							{dnd.dragLabel(dnd.activeDragId)}
						</div>
					) : null}
				</DragOverlay>
			</DndContext>

			{/* Git Setup Modal */}
			<GitSetupModal
				open={showGitSetupModal}
				onOpenChange={(open) => {
					if (!open && selectedProject) {
						// Mark this project as skipped so the modal doesn't reopen due to async re-checks
						gitSetupSkippedForProjectRef.current = selectedProject.id;
					}
					setShowGitSetupModal(open);
				}}
				project={selectedProject || null}
				gitStatus={gitStatus}
				onGitInitialized={handleGitInitialized}
			/>

			{/* AI Tools Dialogs */}
			<TestGenerationDialog />
			<PromptOptimizerDialog />
			<ContextAwareSnippetsDialog />
			<CodePlaygroundDialog />
			<ConflictPredictorDialog />
			<DependencySentinelDialog />
			<NaturalLanguageGitDialog />
			<VoiceAssistant
				destinations={visibleNavItems.map((item) => ({ id: item.id, label: t(item.labelKey) }))}
				onNavigate={(view) => handleNavClick(view as SidebarView)}
				onNewTask={onNewTaskClick}
				onOpenSettings={onSettingsClick}
			/>
			<AppEmulatorDialog />
			<LearningLoopDialog />
			<SmartEstimationDialog />

			<ArenaDialog />
		</TooltipProvider>
	);
}
