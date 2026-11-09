// React

// Types
import type { GitStatus, Project } from "@shared/types";
import { providerFromRemoteUrl } from "@shared/utils/git-remote-provider";
// Drag and drop (dnd-kit)
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
// Icons
import {
	ChevronRight,
	Compass,
	HelpCircle,
	PanelLeft,
	PanelLeftClose,
	Plus,
	RefreshCcw,
	Search,
	Settings,
	Star,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AddProjectModal } from "./AddProjectModal";
import { AzureDevOpsSetupModal } from "./AzureDevOpsSetupModal";
import { AppEmulatorDialog } from "./app-emulator/AppEmulatorDialog";
import { ArenaDialog } from "./arena/ArenaDialog";
import { CodePlaygroundDialog } from "./code-playground/CodePlaygroundDialog";
import { ConflictPredictorDialog } from "./conflict-predictor/ConflictPredictorDialog";
import { ContextAwareSnippetsDialog } from "./context-aware-snippets/ContextAwareSnippetsDialog";
import { DependencySentinelDialog } from "./dependency-sentinel/DependencySentinelDialog";
import { GitHubSetupModal } from "./GitHubSetupModal";
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
import { Separator } from "./ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./ui/tooltip";
import {
	decodeSortableId,
	encodeSortableId,
	FavoritesDropZone,
	FavoritesDropZoneEmpty,
	SortableWrapper,
	type SortableKind,
} from "./sidebar/sortable-primitives";
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
import { CliToolsChip } from "./sidebar/CliToolsChip";
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

	const [showAddProjectModal, setShowAddProjectModal] = useState(false);
	const [showGitSetupModal, setShowGitSetupModal] = useState(false);
	const gitSetupSkippedForProjectRef = useRef<string | null>(null);
	const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
	const [_pendingProject, setPendingProject] = useState<Project | null>(null);
	const {
		prefs: sidebarPrefs,
		toggleItemPin,
		unpinItems,
		toggleGroupPin,
		reorderGroups,
		reorderItems,
		toggleGroupExpanded,
		setFavoritesExpanded,
		setHideExperimental,
		clearAllFavorites,
		reset: resetSidebarPrefs,
		mergeOrder,
	} = useSidebarPrefs();
	const expandedGroups = useMemo(
		() => new Set(sidebarPrefs.expandedGroups),
		[sidebarPrefs.expandedGroups],
	);
	const pinnedItemsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedItems),
		[sidebarPrefs.pinnedItems],
	);
	const pinnedGroupsSet = useMemo(
		() => new Set(sidebarPrefs.pinnedGroups),
		[sidebarPrefs.pinnedGroups],
	);
	const [activeDragId, setActiveDragId] = useState<string | null>(null);
	const shortcutBufferRef = useRef<string>("");
	const shortcutBufferTimeRef = useRef<number>(0);

	const [showGitHubSetup, setShowGitHubSetup] = useState(false);
	const [gitHubSetupProject, setGitHubSetupProject] = useState<Project | null>(
		null,
	);
	const [showAzureDevOpsSetup, setShowAzureDevOpsSetup] = useState(false);
	const [azureDevOpsSetupProject, setAzureDevOpsSetupProject] =
		useState<Project | null>(null);

	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Sidebar collapsed state from settings
	const isCollapsed = settings.sidebarCollapsed ?? false;

	// Sidebar resizable width
	const SIDEBAR_MIN_WIDTH = 200;
	const SIDEBAR_MAX_WIDTH = 480;
	const SIDEBAR_DEFAULT_WIDTH = 256;
	const SIDEBAR_COLLAPSED_WIDTH = 64;

	const sidebarWidth = settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
	const [isResizing, setIsResizing] = useState(false);
	const [resizeWidth, setResizeWidth] = useState(sidebarWidth);
	const resizingRef = useRef(false);

	// Sync resizeWidth when settings change externally
	useEffect(() => {
		if (!resizingRef.current) {
			setResizeWidth(settings.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH);
		}
	}, [settings.sidebarWidth]);

	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			resizingRef.current = true;
			setIsResizing(true);
			const startX = e.clientX;
			const startWidth = resizeWidth;

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const newWidth = Math.min(
					SIDEBAR_MAX_WIDTH,
					Math.max(
						SIDEBAR_MIN_WIDTH,
						startWidth + (moveEvent.clientX - startX),
					),
				);
				setResizeWidth(newWidth);
			};

			const handleMouseUp = () => {
				resizingRef.current = false;
				setIsResizing(false);
				document.removeEventListener("mousemove", handleMouseMove);
				document.removeEventListener("mouseup", handleMouseUp);
				// Persist final width
				setResizeWidth((prev) => {
					saveSettings({ sidebarWidth: prev });
					return prev;
				});
			};

			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		},
		[resizeWidth],
	);

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

	// Compute visible nav groups based on GitHub/GitLab enabled state from store,
	// then apply the user's custom group + per-group item ordering from sidebarPrefs.
	// Order merging is permissive: unknown ids in prefs are dropped, new ids fall
	// through to their default code position — so shipping new menu items doesn't
	// require a settings migration.
	const visibleNavGroups = useMemo(() => {
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

		// Apply custom group order
		const actualGroupIds = groups.map((g) => g.id);
		const orderedGroupIds = mergeOrder(sidebarPrefs.groupOrder, actualGroupIds);
		const byId = new Map(groups.map((g) => [g.id, g]));
		const orderedGroups = orderedGroupIds
			.map((id) => byId.get(id))
			.filter((g): g is NavGroup => Boolean(g));

		// Apply custom per-group item order, without the experimental views
		// when the user hid them
		const gates = { serverProject, hideExperimental: sidebarPrefs.hideExperimental === true };
		return orderedGroups
			.map((group) => {
				const actualItemIds = group.items.map((i) => i.id);
				const preferredOrder = sidebarPrefs.itemOrder[group.id] ?? [];
				const orderedItemIds = mergeOrder(preferredOrder, actualItemIds);
				const itemById = new Map(group.items.map((i) => [i.id, i]));
				const items = orderedItemIds
					.map((id) => itemById.get(id as SidebarView))
					.filter((i): i is NavItem => Boolean(i))
					.filter((i) => itemShown(i, gates));
				return { ...group, items };
			})
			.filter((group) => group.items.length > 0);
	}, [
		sidebarPrefs.hideExperimental,
		githubEnabled,
		gitlabEnabled,
		canAdminister,
		serverProject,
		sidebarPrefs.groupOrder,
		sidebarPrefs.itemOrder,
		mergeOrder,
	]);

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
		() => ({ serverProject, hideExperimental: sidebarPrefs.hideExperimental === true }),
		[serverProject, sidebarPrefs.hideExperimental],
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
				return;
			}

			// Legacy single-char shortcut support (none remain, but kept defensively)
			const matchedItem = visibleNavItems.find((item) => item.shortcut === key);
			if (matchedItem) {
				e.preventDefault();
				onViewChange?.(matchedItem.id);
			}
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

	const inferProviderFromRemote = (
		provider: "github" | "azure_devops" | "unknown",
		remoteUrl?: string,
	) => {
		if (provider !== "unknown" || !remoteUrl) return provider;
		return providerFromRemoteUrl(remoteUrl);
	};

	const handleProjectAdded = async (project: Project, needsInit: boolean) => {
		if (needsInit) {
			setPendingProject(project);
			return;
		}

		try {
			const envResult = await globalThis.electronAPI.getProjectEnv(project.id);
			const envConfig = envResult.success ? envResult.data : null;
			const hasProvider = !!(
				envConfig?.githubEnabled || envConfig?.azureDevOpsEnabled
			);
			if (!hasProvider) {
				const detectionResult = await globalThis.electronAPI.detectRepoProvider(
					project.path,
				);
				const rawProvider = detectionResult.success
					? (detectionResult.data?.provider ?? "unknown")
					: "unknown";
				const provider = inferProviderFromRemote(
					rawProvider,
					detectionResult.data?.remoteUrl,
				);

				setShowGitHubSetup(false);
				setGitHubSetupProject(null);
				setShowAzureDevOpsSetup(false);
				setAzureDevOpsSetupProject(null);

				if (provider === "github") {
					setGitHubSetupProject(project);
					setShowGitHubSetup(true);
					return;
				}

				if (provider === "azure_devops") {
					setAzureDevOpsSetupProject(project);
					setShowAzureDevOpsSetup(true);
					return;
				}
			}
		} catch {
			setShowGitHubSetup(false);
			setGitHubSetupProject(null);
			setShowAzureDevOpsSetup(false);
			setAzureDevOpsSetupProject(null);
		}
	};

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

	const handleGitHubSetupComplete = async (settings: {
		githubToken: string;
		githubRepo: string;
		mainBranch: string;
		githubAuthMethod?: "oauth" | "pat";
	}) => {
		if (!gitHubSetupProject) return;

		try {
			await globalThis.electronAPI.updateProjectEnv(gitHubSetupProject.id, {
				githubEnabled: true,
				githubToken: settings.githubToken,
				githubRepo: settings.githubRepo,
				githubAuthMethod: settings.githubAuthMethod,
				azureDevOpsEnabled: false,
			});

			await globalThis.electronAPI.updateProjectSettings(
				gitHubSetupProject.id,
				{
					mainBranch: settings.mainBranch,
				},
			);
		} catch (error) {
			console.error("Failed to save GitHub settings:", error);
		}

		setShowGitHubSetup(false);
		setGitHubSetupProject(null);
	};

	const handleGitHubSetupSkip = () => {
		setShowGitHubSetup(false);
		setGitHubSetupProject(null);
	};

	const handleAzureDevOpsSetupComplete = async () => {
		setShowAzureDevOpsSetup(false);
		setAzureDevOpsSetupProject(null);
	};

	const handleAzureDevOpsSetupSkip = () => {
		setShowAzureDevOpsSetup(false);
		setAzureDevOpsSetupProject(null);
	};

	const handleNavClick = (view: SidebarView) => openNavView(view, onViewChange);

	const openNavItem = (item: NavItem) => {
		if (!item.hub) return handleNavClick(item.id);
		const target = hubEntryTarget(getHub(item.hub), hubGates);
		if (target) onViewChange?.(target);
	};

	const toggleGroupExpansion = (groupId: string) => {
		toggleGroupExpanded(groupId);
	};

	// Require 6px of pointer movement before starting a drag so regular clicks on
	// menu items (the most common interaction by far) never get swallowed by dnd-kit.
	const dndSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	interface SortableInfo {
		kind: SortableKind;
		id: string;
	}

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveDragId(String(event.active.id));
	}, []);

	// Helper function to handle dropping on favorites
	const handleFavoritesDrop = useCallback((activeInfo: SortableInfo, _overInfo: SortableInfo) => {
		if (activeInfo.kind === "item" && !pinnedItemsSet.has(activeInfo.id)) {
			toggleItemPin(activeInfo.id);
			return true;
		}
		if (activeInfo.kind === "group" && !pinnedGroupsSet.has(activeInfo.id)) {
			toggleGroupPin(activeInfo.id);
			return true;
		}
		return false;
	}, [pinnedItemsSet, pinnedGroupsSet, toggleItemPin, toggleGroupPin]);

	// Helper function to handle group reordering
	const handleGroupReorder = useCallback((activeInfo: SortableInfo, overInfo: SortableInfo) => {
		if (activeInfo.id === overInfo.id) return true;
		const actualOrder = visibleNavGroups.map((g) => g.id);
		reorderGroups(activeInfo.id, overInfo.id, actualOrder);
		return true;
	}, [visibleNavGroups, reorderGroups]);

	// Helper function to handle item reordering within groups
	const handleItemReorder = useCallback((activeInfo: SortableInfo, overInfo: SortableInfo) => {
		if (activeInfo.id === overInfo.id) return true;
		const group = visibleNavGroups.find(
			(g) =>
				g.items.some((i) => i.id === activeInfo.id) &&
				g.items.some((i) => i.id === overInfo.id),
		);
		if (!group) return false;
		const actualOrder = group.items.map((i) => i.id);
		reorderItems(group.id, activeInfo.id, overInfo.id, actualOrder);
		return true;
	}, [visibleNavGroups, reorderItems]);

	// Drag-end router. A drop's effect depends on the decoded "kind" of both
	// active and over ids — group-onto-group reorders, item-onto-item reorders
	// within the same group (cross-group drops are ignored to keep the mental
	// model simple), and dropping an item onto the favorites zone pins it.
	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveDragId(null);
			const { active, over } = event;
			if (!over) return;

			const activeInfo = decodeSortableId(String(active.id));
			const overInfo = decodeSortableId(String(over.id));
			if (!activeInfo || !overInfo) return;

			// Dropped on the favorites drop zone -> pin the item/group
			if (overInfo.kind === "fav-group" || over.id === "__fav_drop__") {
				handleFavoritesDrop(activeInfo, overInfo);
				return;
			}

			// Reorder groups (same kind, both "group")
			if (activeInfo.kind === "group" && overInfo.kind === "group") {
				handleGroupReorder(activeInfo, overInfo);
				return;
			}

			// Reorder items within the same group
			if (activeInfo.kind === "item" && overInfo.kind === "item") {
				handleItemReorder(activeInfo, overInfo);
			}
		},
		[
			handleFavoritesDrop,
			handleGroupReorder,
			handleItemReorder,
		],
	);

	// The two-letter shortcut lives in the hover title, not on every row
	const navItemTitle = (item: NavItem) => {
		const title = navLabelTitle(t, item.labelKey, isItemExperimental(item));
		return item.shortcut ? `${title} · ${item.shortcut}` : title;
	};

	const renderNavItem = (
		item: NavItem,
		isSubItem = false,
		context: "default" | "favorites" = "default",
	) => {
		const isActive = isOn(item, activeView);
		const Icon = item.icon;
		const isPinned = itemViews(item).some((view) => pinnedItemsSet.has(view));
		const badge = groupBadgeFor([item]);
		const hasAttention = isOn(item, attentionView);

		// Determine CSS classes based on collapsed state and sub-item status
		const getLayoutClasses = () => {
			if (isCollapsed) {
				return "justify-center px-2 py-2";
			}
			if (isSubItem) {
				return "gap-3 px-3 py-1.5 ml-4";
			}
			return "gap-3 px-3 py-2";
		};

		// Pin star lives OUTSIDE the nav button (nested <button> is invalid HTML).
		// It is an absolute overlay so the nav button keeps the full row width;
		// it only appears on hover/focus, fading the kbd shortcut underneath.
		// right-2 (8px) + the 7px inset of the items box = 15px from the sidebar
		// inner edge — must match the group pin star (right-[15px]) so all stars align.
		const starButton = !isCollapsed && context !== "favorites" ? (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					if (isPinned && item.hub) unpinItems(itemViews(item));
					else toggleItemPin(item.id);
				}}
				aria-label={
					isPinned
						? t("navigation:actions.unpin")
						: t("navigation:actions.pin")
				}
				aria-pressed={isPinned}
				className={cn(
					"absolute right-2 top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"hover:bg-accent/60 hover:scale-110",
					"opacity-0 group-hover/nav-item:opacity-100 focus-visible:opacity-100",
					isPinned
						? "text-warning"
						: "text-muted-foreground/40 hover:text-warning",
				)}
			>
				<Star
					className={cn("h-3.5 w-3.5", isPinned && "fill-warning")}
				/>
			</button>
		) : null;

		const button = (
			<div
				key={item.id}
				className="group/nav-item relative flex items-center"
			>
				<button
					type="button"
					onClick={() => openNavItem(item)}
					// The console is deployment-scoped, not project-scoped.
					disabled={!selectedProjectId && item.id !== "administration"}
					aria-keyshortcuts={item.shortcut}
					className={cn(
						"flex w-full min-w-0 items-center rounded-lg text-sm transition-all duration-200",
						"hover:bg-accent hover:text-accent-foreground",
						"disabled:pointer-events-none disabled:opacity-50",
						isActive && "bg-accent text-accent-foreground",
						isPinned &&
							!isActive &&
							context !== "favorites" &&
							"ring-1 ring-inset ring-warning/20 shadow-[inset_0_0_12px_-6px_rgba(251,191,36,0.25)]",
						getLayoutClasses(),
					)}
				>
					<NavIcon icon={Icon} experimental={isItemExperimental(item)} />
					{!isCollapsed && (
						<>
							<span className="flex-1 text-left truncate" title={navItemTitle(item)}>
								{t(item.labelKey)}
							</span>
							<ActivityBadge badge={badge} attention={hasAttention} />
						</>
					)}
				</button>
				{starButton}
				{isCollapsed && (
					<ActivityBadge
						badge={badge}
						attention={hasAttention}
						variant="corner"
					/>
				)}
			</div>
		);

		// Wrap in tooltip when collapsed
		if (isCollapsed) {
			return (
				<Tooltip key={item.id}>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent side="right">
						<span>{t(item.labelKey)}</span>
						{isItemExperimental(item) && (
							<span className="ml-2 text-warning">{t("navigation:experimental.badge")}</span>
						)}
						{item.shortcut && (
							<kbd className="ml-2 rounded border border-border bg-secondary px-1 font-mono text-3xs">
								{item.shortcut}
							</kbd>
						)}
					</TooltipContent>
				</Tooltip>
			);
		}

		return button;
	};

	const groupItemsBySubGroup = (items: NavItem[]) => {
		const subGroups: { key: string; items: NavItem[] }[] = [];
		for (const item of items) {
			const key = item.subGroup ?? "";
			const last = subGroups.at(-1);
			if (last?.key === key) {
				last.items.push(item);
			} else {
				subGroups.push({ key, items: [item] });
			}
		}
		return subGroups;
	};

	const renderTooltipSubGroupItem = (item: NavItem) => {
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

	const renderTooltipItems = (items: NavItem[]) => {
		const hasSubGroups = items.some((item) => item.subGroup);

		if (!hasSubGroups) {
			return items.map(renderTooltipSubGroupItem);
		}

		const subGroups = groupItemsBySubGroup(items);
		return subGroups.map((sg, sgIndex) => (
			<div
				key={sg.key}
				className={cn(
					"rounded bg-white/4 border border-white/8 px-1 py-1",
					sgIndex > 0 && "mt-1",
				)}
			>
				{sg.key && (
					<div className="text-3xs font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pb-0.5">
						{t(sg.key)}
					</div>
				)}
				{sg.items.map(renderTooltipSubGroupItem)}
			</div>
		));
	};

	const renderExpandedSubGroupItem = (
		item: NavItem,
		delay: number,
		context: "default" | "favorites" = "default",
	) => {
		// Items inside the favorites group are mirrors of the originals — they are
		// not independently sortable, so we skip the SortableWrapper there. This
		// keeps dnd-kit ids unique (only "item:<id>" exists, not "fav-item:<id>").
		if (context === "favorites") {
			return (
				<div
					key={item.id}
					className="animate-in slide-in-from-left-2 duration-200 ease-out"
					style={{ animationDelay: `${delay}ms` }}
				>
					{renderNavItem(item, true, context)}
				</div>
			);
		}
		return (
			<SortableWrapper
				key={item.id}
				sortableId={encodeSortableId("item", item.id)}
			>
				{({ setNodeRef, style, isDragging, dragHandle }) => (
					<div
						ref={setNodeRef}
						style={{ ...style, animationDelay: `${delay}ms` }}
						className={cn(
							"relative group animate-in slide-in-from-left-2 duration-200 ease-out",
							DRAG_SLOT_REVEAL,
							isDragging &&
								"ring-1 ring-primary/50 rounded-lg bg-background/80 backdrop-blur",
						)}
					>
						<div data-drag-slot className="absolute left-1 top-1/2 -translate-y-1/2 z-10">
							{dragHandle}
						</div>
						{renderNavItem(item, true, context)}
					</div>
				)}
			</SortableWrapper>
		);
	};

	// Helper function to render sub-group items with proper indexing
	const renderSubGroupItems = (items: NavItem[], context: "default" | "favorites") => {
		let itemIndex = 0;
		return items.map((item) => {
			const delay = itemIndex * 50;
			itemIndex++;
			return renderExpandedSubGroupItem(item, delay, context);
		});
	};

	// Helper function to render sub-groups
	const renderSubGroups = (items: NavItem[], context: "default" | "favorites") => {
		const subGroups = groupItemsBySubGroup(items);
		return subGroups.map((sg, sgIndex) => (
			<div
				key={sg.key}
				className={cn(
					"rounded-lg overflow-hidden bg-white/4 border border-white/8 px-1.5 py-1.5",
					sgIndex > 0 && "mt-2",
				)}
			>
				{sg.key && (
					<div className="px-2 py-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground/70">
						{t(sg.key)}
					</div>
				)}
				<div className="space-y-0.5">
					{renderSubGroupItems(sg.items, context)}
				</div>
			</div>
		));
	};

	const renderExpandedItems = (
		items: NavItem[],
		context: "default" | "favorites" = "default",
	) => {
		const hasSubGroups = items.some((item) => item.subGroup);
		const sortableIds = items.map((i) => encodeSortableId("item", i.id));

		const content = hasSubGroups ? (
			renderSubGroups(items, context)
		) : (
			<div className="rounded-lg overflow-hidden bg-white/4 border border-white/8 px-1.5 py-1.5 space-y-0.5">
				{items.map((item, index) =>
					renderExpandedSubGroupItem(item, index * 50, context),
				)}
			</div>
		);

		if (context === "favorites") return content;
		return (
			<SortableContext
				items={sortableIds}
				strategy={verticalListSortingStrategy}
			>
				{content}
			</SortableContext>
		);
	};

	// Helper function to determine if a group is expanded
	const getGroupExpandedState = (group: NavGroup, isFavorites: boolean): boolean => {
		if (isFavorites) {
			return sidebarPrefs.favoritesExpanded;
		}
		return expandedGroups.has(group.id);
	};

	// Helper function to get icon container className
	const getIconContainerClassName = (isFavorites: boolean, hasActiveItem: boolean): string => {
		if (isFavorites) {
			return "bg-warning/10 text-warning";
		}
		if (hasActiveItem) {
			return "bg-primary/10 text-primary";
		}
		return "text-muted-foreground";
	};

	// Helper function to render collapsed group
	const renderCollapsedGroup = (group: NavGroup, hasActiveItem: boolean) => {
		const GroupIcon = group.icon;
		const isFavorites = group.id === "__favorites__";
		// On the rail there is no room for a row, so the group icon carries the
		// rollup of everything folded behind it.
		const groupBadge = groupBadgeFor(group.items);
		const groupAttention = group.items.some((item) => isOn(item, attentionView));

		return (
			<Tooltip key={group.id}>
				<TooltipTrigger asChild>
					<div className="flex flex-col items-center gap-1 py-2">
						<div
							className={cn(
								"relative flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 hover:scale-105",
								hasActiveItem
									? "bg-accent text-accent-foreground shadow-sm"
									: "hover:bg-accent hover:text-accent-foreground",
								isFavorites && "ring-1 ring-warning/40",
							)}
						>
							<GroupIcon
								className={cn(
									"h-4 w-4",
									isFavorites && "fill-warning text-warning",
								)}
							/>
							<ActivityBadge
								badge={groupBadge}
								attention={groupAttention}
								variant="corner"
							/>
						</div>
					</div>
				</TooltipTrigger>
				<TooltipContent side="right" className="max-w-xs">
					<div className="space-y-2">
						<p className="font-medium text-sm">{t(group.labelKey)}</p>
						<div className="space-y-1">{renderTooltipItems(group.items)}</div>
					</div>
				</TooltipContent>
			</Tooltip>
		);
	};

	const renderNavGroup = (
		group: NavGroup,
		context: "default" | "favorites" = "default",
	) => {
		const isFavorites = group.id === "__favorites__";
		const isExpanded = getGroupExpandedState(group, isFavorites);
		const hasActiveItem = group.items.some((item) => isOn(item, activeView));
		const isPinned = pinnedGroupsSet.has(group.id);

		if (isCollapsed) {
			// In collapsed mode, show group icon with tooltip containing all items
			return renderCollapsedGroup(group, hasActiveItem);
		}

		// Helper function to render the pin button
	const renderPinButton = (group: NavGroup, isPinned: boolean, context: "default" | "favorites") => {
		const isFavorites = group.id === "__favorites__";
		
		if (context === "favorites" || isFavorites) {
			return null;
		}

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					toggleGroupPin(group.id);
				}}
				aria-label={
					isPinned
						? t("navigation:actions.unpinGroup")
						: t("navigation:actions.pinGroup")
				}
				aria-pressed={isPinned}
				className={cn(
					// right-[15px] = the item star's right-2 (8px) + the 7px inset
					// (border + px-1.5) of the items box, so group and item stars align.
					"absolute right-[15px] top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"hover:bg-accent/60 hover:scale-110",
					"opacity-0 group-hover/group-header:opacity-100 focus-visible:opacity-100",
					isPinned
						? "text-warning"
						: "text-muted-foreground/40 hover:text-warning",
				)}
			>
				<Star
					className={cn("h-3.5 w-3.5", isPinned && "fill-warning")}
				/>
			</button>
		);
	};

	// Helper function to render the clear favorites button
	const renderClearFavoritesButton = (isFavorites: boolean) => {
		if (!isFavorites) {
			return null;
		}

		return (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					clearAllFavorites();
				}}
				aria-label={t("navigation:actions.clearAllFavorites")}
				title={t("navigation:actions.clearAllFavorites")}
				className={cn(
					// The favorites card adds a 5px inset (border + p-1), so right-[10px]
					// lands at the same 15px-from-sidebar-edge line as the other stars.
					"absolute right-[10px] top-1/2 -translate-y-1/2 z-10",
					"flex items-center justify-center w-5 h-5 rounded",
					"transition-all duration-200",
					"opacity-0 group-hover/group-header:opacity-100 focus-visible:opacity-100",
					"text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 hover:scale-110",
				)}
			>
				<X className="h-3.5 w-3.5" />
			</button>
		);
	};

	// Helper function to render the main group button
	const renderGroupButton = (group: NavGroup, isExpanded: boolean, hasActiveItem: boolean) => {
		const isFavorites = group.id === "__favorites__";
		const GroupIcon = group.icon;
		// A collapsed group hides its entries, so it carries the worst state
		// among them — otherwise work in a folded group is invisible.
		const groupBadge = isExpanded ? null : groupBadgeFor(group.items);
		const groupAttention = group.items.some((item) => isOn(item, attentionView));
		
		const toggleExpand = () => {
			if (isFavorites) {
				setFavoritesExpanded(!isExpanded);
			} else {
				toggleGroupExpansion(group.id);
			}
		};

		return (
			<button
				type="button"
				onClick={toggleExpand}
				className={cn(
					"flex w-full min-w-0 items-center rounded-md text-sm transition-colors duration-200",
					"hover:bg-accent/60 hover:text-accent-foreground",
					hasActiveItem && "text-foreground",
					"gap-2 px-3 py-1.5",
				)}
			>
				<div
					className={cn(
						"flex items-center justify-center w-5 h-5 rounded transition-colors shrink-0",
						getIconContainerClassName(isFavorites, hasActiveItem),
					)}
				>
					<GroupIcon
						className={cn(
							"h-4 w-4",
							isFavorites && "fill-warning text-warning",
						)}
					/>
				</div>
				<span className="flex-1 text-left font-medium truncate">
					{t(group.labelKey)}
				</span>
				<div
					className={cn(
						"flex items-center gap-1 shrink-0",
						// Fades out under the pin star (or favorites X) on header hover.
						"transition-opacity duration-200 group-hover/group-header:opacity-0",
					)}
				>
					<ActivityBadge
						badge={groupBadge}
						attention={groupAttention && !isExpanded}
					/>
					<ChevronRight
						className={cn(
							"h-4 w-4 shrink-0 transition-transform duration-300 text-muted-foreground",
							isExpanded && "rotate-90",
						)}
					/>
				</div>
			</button>
		);
	};

		return (
			<div
				key={group.id}
				className={cn(
					"space-y-1",
					isFavorites &&
						"rounded-lg bg-linear-to-b from-amber-400/5 to-transparent border border-warning/20 p-1",
				)}
			>
				<div className="group/group-header relative flex items-center">
					{renderGroupButton(group, isExpanded, hasActiveItem)}
					{renderPinButton(group, isPinned, context)}
					{renderClearFavoritesButton(isFavorites)}
				</div>

				{isExpanded && (
					<div className="space-y-1 animate-in slide-in-from-top-2 duration-300 ease-out">
						{renderExpandedItems(group.items, context)}
					</div>
				)}
			</div>
		);
	};

	return (
		<TooltipProvider>
			<div
				className={cn(
					"relative flex h-full flex-col bg-sidebar border-r border-border",
					!isResizing && "transition-all duration-300",
				)}
				style={{ width: isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : resizeWidth }}
			>
				{/* Header with drag area - extra top padding for macOS traffic lights */}
				<div
					className={cn(
						"electron-drag flex h-14 items-center pt-6 transition-all duration-300",
						isCollapsed ? "justify-center px-2" : "px-4",
					)}
				>
					{isCollapsed ? (
						<div className="electron-no-drag flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-bold text-sm">
							W
						</div>
					) : (
						<span className="electron-no-drag text-lg font-bold text-primary">
							WorkPilot AI
						</span>
					)}
				</div>

				{/* Toggle + Search row */}
				<div
					className={cn(
						"flex items-center py-2 transition-all duration-300",
						isCollapsed ? "justify-center px-2" : "justify-end gap-1 px-3",
					)}
				>
					{/* Search: the command palette, which lists every page */}
					{!isCollapsed && (
						<button
							type="button"
							onClick={openCommandPalette}
							title={t("search.openTooltip")}
							data-testid="sidebar-search"
							className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
						>
							<Search className="h-3.5 w-3.5 shrink-0" />
							<span className="flex-1 truncate text-left">{t("search.open")}</span>
							<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
								Ctrl K
							</kbd>
						</button>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 shrink-0"
								onClick={toggleSidebar}
								aria-label={
									isCollapsed
										? t("actions.expandSidebar")
										: t("actions.collapseSidebar")
								}
							>
								{isCollapsed ? (
									<PanelLeft className="h-4 w-4" />
								) : (
									<PanelLeftClose className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">
							{isCollapsed
								? t("actions.expandSidebar")
								: t("actions.collapseSidebar")}
						</TooltipContent>
					</Tooltip>
				</div>

				<Separator />

				{/* Navigation */}
				<ScrollArea className="flex-1">
					<div
						className={cn(
							"py-4 transition-all duration-300",
							isCollapsed ? "px-2" : "px-3",
						)}
					>
						{/* Navigation Groups with DnD */}
						<DndContext
							sensors={dndSensors}
							collisionDetection={closestCenter}
							onDragStart={handleDragStart}
							onDragEnd={handleDragEnd}
							onDragCancel={() => setActiveDragId(null)}
						>
							<div className="space-y-2">
								{favoritesGroup && (
									<FavoritesDropZone
										isDragging={Boolean(activeDragId)}
										active={Boolean(
											activeDragId &&
												decodeSortableId(activeDragId)?.kind !== "fav-group",
										)}
									>
										{renderNavGroup(favoritesGroup, "favorites")}
									</FavoritesDropZone>
								)}
								{!favoritesGroup &&
									!isCollapsed &&
									Boolean(activeDragId) && (
										<FavoritesDropZoneEmpty
											label={t("navigation:favorites.dropHint")}
										/>
									)}
								<SortableContext
									items={visibleNavGroups.map((g) =>
										encodeSortableId("group", g.id),
									)}
									strategy={verticalListSortingStrategy}
								>
									{visibleNavGroups.map((group) => (
										<SortableWrapper
											key={group.id}
											sortableId={encodeSortableId("group", group.id)}
											disabled={isCollapsed}
										>
											{({ setNodeRef, style, isDragging, dragHandle }) => (
												<div
													ref={setNodeRef}
													style={style}
													className={cn(
														"relative group",
														DRAG_SLOT_REVEAL,
														isDragging &&
															"ring-1 ring-primary/50 rounded-lg bg-background/80 backdrop-blur",
													)}
												>
													{!isCollapsed && (
														<div data-drag-slot className="absolute -left-0.5 top-2.5 z-10">
															{dragHandle}
														</div>
													)}
													{renderNavGroup(group)}
												</div>
											)}
										</SortableWrapper>
									))}
								</SortableContext>
								{!isCollapsed &&
									(sidebarPrefs.pinnedItems.length > 0 ||
										sidebarPrefs.pinnedGroups.length > 0 ||
										sidebarPrefs.groupOrder.length > 0 ||
										Object.keys(sidebarPrefs.itemOrder).length > 0) && (
										<button
											type="button"
											onClick={resetSidebarPrefs}
											className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
										>
											<RefreshCcw className="h-3 w-3" />
											{t("navigation:actions.resetLayout")}
										</button>
									)}
								{!isCollapsed && (
									<button
										type="button"
										onClick={() =>
											setHideExperimental(sidebarPrefs.hideExperimental !== true)
										}
										aria-pressed={sidebarPrefs.hideExperimental === true}
										className="mt-1 w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
									>
										{sidebarPrefs.hideExperimental === true
											? t("navigation:experimental.show", {
													count: EXPERIMENTAL_VIEWS.size,
												})
											: t("navigation:experimental.hide")}
									</button>
								)}
							</div>
							<DragOverlay dropAnimation={null}>
								{activeDragId ? (
									<div className="rounded-lg bg-accent/80 backdrop-blur border border-primary/40 shadow-2xl px-3 py-2 text-sm">
										{(() => {
											const info = decodeSortableId(activeDragId);
											if (!info) return null;
											if (info.kind === "group") {
												const g = visibleNavGroups.find(
													(x) => x.id === info.id,
												);
												return g ? t(g.labelKey) : null;
											}
											const item = visibleNavGroups
												.flatMap((x) => x.items)
												.find((x) => x.id === info.id);
											return item ? t(item.labelKey) : null;
										})()}
									</div>
								) : null}
							</DragOverlay>
						</DndContext>
					</div>
				</ScrollArea>

				<Separator />

				{/* Rate Limit Indicator - shows when Claude is rate limited */}
				<RateLimitIndicator />

				{/* Update Banner - shows when app update is available */}
				<UpdateBanner />

				{/* API keys stored without the OS keyring (rule S1) */}
				<SecureStorageBanner />

				{/* Bottom section: CLI chip, settings, help, New Task */}
				<div
					className={cn(
						"space-y-3 transition-all duration-300",
						isCollapsed ? "p-2" : "p-4",
					)}
				>
					{/* Settings and Help row — always visible, outside the CLI collapsible */}
					<div
						className={cn(
							"flex items-center",
							isCollapsed ? "flex-col gap-1" : "gap-1",
						)}
					>
						{/* The CLI tools, folded into a chip that opens their badges */}
						<CliToolsChip
							isCollapsed={isCollapsed}
							onNavigateToTerminals={() => onViewChange?.("terminals", true)}
						/>
						{!isCollapsed && <span className="flex-1" />}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									onClick={onSettingsClick}
									aria-label={t("actions.settings")}
								>
									<Settings className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side={isCollapsed ? "right" : "top"}>
								{t("tooltips.settings")}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => openSetupHub()}
									aria-label={t("setupHub:title")}
								>
									<Compass className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side={isCollapsed ? "right" : "top"}>
								{t("setupHub:title")}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									onClick={() =>
										globalThis.open(
											"https://github.com/krovomi/WorkPilot-AI/issues",
											"_blank",
										)
									}
									aria-label={t("tooltips.help")}
								>
									<HelpCircle className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side={isCollapsed ? "right" : "top"}>
								{t("tooltips.help")}
							</TooltipContent>
						</Tooltip>
					</div>

					{/* New Task button */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className="w-full"
								size={isCollapsed ? "icon" : "default"}
								onClick={onNewTaskClick}
								disabled={!selectedProjectId || !selectedProject?.autoBuildPath}
							>
								<Plus className={isCollapsed ? "h-4 w-4" : "mr-2 h-4 w-4"} />
								{!isCollapsed && t("actions.newTask")}
							</Button>
						</TooltipTrigger>
						{isCollapsed && (
							<TooltipContent side="right">
								{t("actions.newTask")}
							</TooltipContent>
						)}
					</Tooltip>
					{!isCollapsed &&
						selectedProject &&
						!selectedProject.autoBuildPath && (
							// The hint used to be plain text pointing at an
							// initialization dialog that no longer rendered: a project
							// added from an existing folder had no way from here to
							// its first task. It now opens the pane that initializes it.
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

				{/* Resize handle */}
				{!isCollapsed && (
					// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
					// biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize handle — mouse drag interaction
					<div
						onMouseDown={handleResizeStart}
						className={cn(
							"absolute top-0 right-0 w-1 h-full cursor-col-resize z-50 transition-colors",
							"hover:bg-primary/40",
							isResizing && "bg-primary/60",
						)}
					/>
				)}
			</div>

			{/* Add Project Modal */}
			<AddProjectModal
				open={showAddProjectModal}
				onOpenChange={setShowAddProjectModal}
				onProjectAdded={handleProjectAdded}
			/>

			{/* Azure DevOps Setup Modal - configure Azure DevOps */}
			{azureDevOpsSetupProject && (
				<AzureDevOpsSetupModal
					open={showAzureDevOpsSetup}
					onOpenChange={setShowAzureDevOpsSetup}
					project={azureDevOpsSetupProject}
					onComplete={handleAzureDevOpsSetupComplete}
					onSkip={handleAzureDevOpsSetupSkip}
				/>
			)}

			{/* GitHub Setup Modal - configure GitHub */}
			{gitHubSetupProject && !showAzureDevOpsSetup && (
				<GitHubSetupModal
					open={showGitHubSetup}
					onOpenChange={setShowGitHubSetup}
					project={gitHubSetupProject}
					onComplete={handleGitHubSetupComplete}
					onSkip={handleGitHubSetupSkip}
				/>
			)}

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
