import { JevSettings } from "./JevSettings";
import { BrainSettings } from "./BrainSettings";
import {
	AlertTriangle,
	ChevronRight,
	Compass,
	Loader2,
	Save,
	Search,
	Settings,
	Sparkles,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@shared/types/settings";
import type { UseProjectSettingsReturn } from "@/components/project-settings";
import { TerminalFontSettings } from "@/components/settings/terminal-font-settings";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useServerSessionStore } from "@/stores/server-session-store";
import { useGuidedTourStore } from "../guided-tour/guided-tour-store";
import { InvitationsAdmin } from "../auth/InvitationsAdmin";
import { CollaborationSettings } from "../collaboration/CollaborationSettings";
import { ServerMcpSettings } from "./ServerMcpSettings";
import { ServerNeedsYouSettings } from "./ServerNeedsYouSettings";
import { ServerTokensSettings } from "./ServerTokensSettings";
import { ModuleStage, Notice, toneClass } from "../charter";
import { Button } from "../ui/button";
import {
	FullScreenDialog,
	FullScreenDialogBody,
	FullScreenDialogContent,
	FullScreenDialogDescription,
	FullScreenDialogFooter,
	FullScreenDialogHeader,
	FullScreenDialogTitle,
} from "../ui/full-screen-dialog";
import { AdvancedSettings } from "./AdvancedSettings";
import { AnomalyDetectionSettings } from "./AnomalyDetectionSettings";
import { CleanProviderSection } from "./CleanProviderSection";
import { DebugSettings } from "./DebugSettings";
import { DevToolsSettings } from "./DevToolsSettings";
import { DisplaySettings } from "./DisplaySettings";
import { GeneralSettings } from "./GeneralSettings";
import { useSettings } from "./hooks/useSettings";
import { LanguageSettings } from "./LanguageSettings";
import { VoiceAssistantSettings } from "./VoiceAssistantSettings";
import { ProjectSettingsContent } from "./ProjectSettingsContent";
import { GuardrailsSettings } from "./GuardrailsSettings";
import { SandboxSettings } from "./SandboxSettings";
import { SchedulerSettings } from "./SchedulerSettings";
import { SettingsPageContext } from "./SettingsSection";
import { resolveSettingsLanding } from "./settings-landing";
import { filterSettingsThemes } from "./settings-search";
import { createSettingsThemes, type SettingsTheme, themeOfSection } from "./settings-themes";
import { SwarmModeSettings } from "./SwarmModeSettings";
import { ThemeSettings } from "./ThemeSettings";

interface AppSettingsDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly initialSection?: AppSection;
	readonly initialProjectSection?: ProjectSettingsSection;
	readonly initialProjectId?: string;
	readonly onRerunWizard?: () => void;
	/** Closes settings and opens the guided Setup Hub ("Centre de configuration"). */
	readonly onOpenSetupHub?: () => void;
}

// Types de sections thématiques
export type AppSection =
	| "jev"
	| "brain"
	// Projet (priorité 1)
	| "project"
	// Intégrations & Connexions (priorité 2)
	| "integrations"
	| "accounts"
	// Interface & Apparence
	| "appearance"
	| "display"
	| "language"
	| "voice-assistant"
	| "terminal-fonts"
	// Développement & Outils
	| "devtools"
	| "paths"
	| "agent"
	// Sécurité & Performance
	| "sandbox"
	| "guardrails"
	| "anomaly-detection"
	// Multi-utilisateurs (serveur ; les invitations pour les admins seulement)
	| "team-invitations"
	| "server-tokens"
	| "server-mcp"
	| "server-needs-you"
	| "server-collaboration"
	// Système & Maintenance
	| "updates"
	| "notifications"
	| "debug"
	| "scheduler"
	| "swarm-mode";

export type ProjectSettingsSection =
	| "general"
	| "azure-devops"
	| "jira"
	| "figma"
	| "cicd"
	| "automations"
	| "board-mcp"
	| "github"
	| "gitlab"
	| "linear"
	| "teams";

export type { SettingsTheme };

/**
 * App sections that manage their own multi-column layout and are rendered at the
 * full width of the settings pane.
 */
const WIDE_APP_SECTIONS = new Set(["accounts", "terminal-fonts"]);

/**
 * Main application settings dialog container
 * Coordinates app and project settings sections
 */
export function AppSettingsDialog(props: AppSettingsDialogProps) {
	const {
		open,
		onOpenChange,
		initialSection,
		initialProjectSection,
		initialProjectId,
		onRerunWizard,
		onOpenSetupHub,
	} = props;
	const { t } = useTranslation(["settings", "swarm", "brain"]);
	const {
		settings,
		setSettings,
		isSaving,
		error,
		saveSettings,
		revertTheme,
		commitTheme,
	} = useSettings();
	const [version, setVersion] = useState<string>("");

	// While the guided tour is running it drives this dialog; ignore stray close
	// requests (the tour overlay portal counts as an "outside" interaction for
	// the non-modal Radix dialog and would otherwise dismiss Settings).
	const isTourActive = useGuidedTourStore((s) => s.isActive);

	// Create dynamic settings themes with translations
	const SETTINGS_THEMES = createSettingsThemes(t);

	// The team-invitations section is admin-only and only relevant in server
	// mode; drop it from the nav otherwise.
	const serverMode = useServerSessionStore((state) => state.mode);
	const serverUserRole = useServerSessionStore((state) => state.user?.role);
	const isServerAdmin = serverMode === "server" && serverUserRole === "admin";
	// The person's own tokens on the server: anyone signed in to one.
	const hidden = new Set([
		...(isServerAdmin ? [] : ["team-invitations"]),
		...(serverMode === "server" ? [] : [
					"server-tokens",
					"server-mcp",
					"server-needs-you",
					"server-collaboration",
				]),
	]);
	SETTINGS_THEMES.integrations.sections =
		SETTINGS_THEMES.integrations.sections.filter((s) => !hidden.has(s.id));

	// Project state (déclaré avant tout usage)
	const projects = useProjectStore((state) => state.projects);
	const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
	const selectProject = useProjectStore((state) => state.selectProject);
	const selectedProject = projects.find((p) => p.id === selectedProjectId);

	// Track which top-level section is active
	const [activeTopLevel, setActiveTopLevel] = useState<"app" | "project">(
		"app",
	);
	const [appSection, setAppSection] = useState<AppSection>(
		initialSection || "appearance",
	);
	const [projectSection, setProjectSection] =
		useState<ProjectSettingsSection>("general");
	// Whether this opening has already chosen where to land. See the effect below.
	const hasLandedRef = useRef(false);
	// A project pane is worth landing on only once there is a project behind it.
	// `initialProjectId` counts: it is the caller naming one the store has not
	// caught up with yet.
	const hasProjectToShow = Boolean(selectedProject || initialProjectId);
	const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [collapsedThemes, setCollapsedThemes] = useState<Set<SettingsTheme>>(
		new Set(),
	);

	// Function to navigate to accounts section
	const handleOpenAccountsSettings = () => {
		setActiveTopLevel("app");
		setAppSection("accounts");
	};

	// Listen for cross-component navigation requests (fired by descendants like
	// project-settings/GeneralSettings to jump to the global "Agent" section, and
	// by the guided tour to switch sections while the dialog is already open).
	useEffect(() => {
		if (!open) return;
		const handler = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					section?: AppSection;
					projectSection?: ProjectSettingsSection;
				}>
			).detail;
			if (detail?.projectSection) {
				setActiveTopLevel("project");
				setProjectSection(detail.projectSection);
				return;
			}
			if (detail?.section) {
				setActiveTopLevel("app");
				setAppSection(detail.section);
			}
		};
		window.addEventListener("app-settings:navigate", handler);
		return () => window.removeEventListener("app-settings:navigate", handler);
	}, [open]);

	// Function to toggle theme collapse
	const toggleThemeCollapse = (themeKey: SettingsTheme) => {
		setCollapsedThemes((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(themeKey)) {
				newSet.delete(themeKey);
			} else {
				newSet.add(themeKey);
			}
			return newSet;
		});
	};

	// Where the dialog opens. The decision itself is `resolveSettingsLanding`;
	// this only applies it and remembers that it was made.
	useEffect(() => {
		if (!open) {
			// The landing is chosen once per opening; forgetting it here is what
			// lets the *next* opening choose again.
			hasLandedRef.current = false;
			return;
		}
		const landing = resolveSettingsLanding({
			initialSection,
			initialProjectSection,
			hasProjectToShow,
			hasLanded: hasLandedRef.current,
		});
		if (!landing) return;

		hasLandedRef.current = landing.landed;
		setActiveTopLevel(landing.topLevel);
		if (landing.appSection) setAppSection(landing.appSection);
		if (landing.projectSection) setProjectSection(landing.projectSection);
	}, [open, initialSection, initialProjectSection, hasProjectToShow]);

	// Synchronise la section projet dès qu'un projet est sélectionné et que le dialog s'ouvre
	useEffect(() => {
		if (open && selectedProject && initialProjectSection) {
			setActiveTopLevel("project");
			setProjectSection(initialProjectSection);
		}
	}, [open, selectedProject, initialProjectSection]);

	// Synchronisation du projet sélectionné avec initialProjectId
	useEffect(() => {
		if (initialProjectId && initialProjectId !== selectedProjectId) {
			selectProject(initialProjectId);
		}
	}, [initialProjectId, selectedProjectId, selectProject]);

	// Project settings hook state (lifted from child)
	const [projectSettingsHook, setProjectSettingsHook] =
		useState<UseProjectSettingsReturn | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);

	// Load app version on mount
	useEffect(() => {
		globalThis.electronAPI.getAppVersion().then(setVersion);
	}, []);

	// Memoize the callback to avoid infinite loops
	const handleProjectHookReady = useCallback(
		(hook: UseProjectSettingsReturn | null) => {
			setProjectSettingsHook(hook);
			if (hook) {
				setProjectError(hook.error || hook.envError || null);
			} else {
				setProjectError(null);
			}
		},
		[],
	);

	const handleSave = async () => {
		// Save app settings first
		const appSaveSuccess = await saveSettings();

		// If on project section with a project selected, save project settings too
		if (
			activeTopLevel === "project" &&
			selectedProject &&
			projectSettingsHook
		) {
			await projectSettingsHook.handleSave(() => {
				/* noop */
			});
			// Check for project errors
			if (projectSettingsHook.error || projectSettingsHook.envError) {
				setProjectError(
					projectSettingsHook.error || projectSettingsHook.envError,
				);
				return; // Don't close dialog on error
			}
		}

		if (appSaveSuccess) {
			// Commit the theme so future cancels won't revert to old values
			commitTheme();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		// onOpenChange handler will revert theme changes
		onOpenChange(false);
	};

	const renderAppSection = () => {
		switch (appSection) {
			case "jev":
				return <JevSettings />;
			case "brain":
				return <BrainSettings />;
			case "appearance":
				return (
					<ThemeSettings settings={settings} onSettingsChange={setSettings} />
				);
			case "display":
				return (
					<DisplaySettings settings={settings} onSettingsChange={setSettings} />
				);
			case "language":
				return (
					<LanguageSettings
						settings={settings}
						onSettingsChange={setSettings}
					/>
				);
			case "voice-assistant":
				return (
					<VoiceAssistantSettings
						settings={settings}
						onSettingsChange={setSettings}
					/>
				);
			case "devtools":
				return (
					<DevToolsSettings
						settings={settings}
						onSettingsChange={setSettings}
					/>
				);
			case "terminal-fonts":
				return <TerminalFontSettings />;
			case "agent":
				return (
					<GeneralSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="agent"
						onOpenAccountsSettings={handleOpenAccountsSettings}
					/>
				);
			case "paths":
				return (
					<GeneralSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="paths"
						onOpenAccountsSettings={handleOpenAccountsSettings}
					/>
				);
			case "accounts":
				return (
					<CleanProviderSection
						settings={settings as AppSettings & Record<string, unknown>}
						onSettingsChange={setSettings}
						isOpen={open}
					/>
				);
			case "updates":
				return (
					<AdvancedSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="updates"
						version={version}
					/>
				);
			case "notifications":
				return (
					<AdvancedSettings
						settings={settings}
						onSettingsChange={setSettings}
						section="notifications"
						version={version}
					/>
				);
			case "debug":
				return <DebugSettings />;
			case "sandbox":
				return <SandboxSettings />;
			case "guardrails":
				return <GuardrailsSettings />;
			case "anomaly-detection":
				return <AnomalyDetectionSettings />;
			case "scheduler":
				return <SchedulerSettings />;
			case "swarm-mode":
				return <SwarmModeSettings />;
			case "team-invitations":
				return isServerAdmin ? <InvitationsAdmin /> : null;
			case "server-tokens":
				return serverMode === "server" ? <ServerTokensSettings /> : null;
			case "server-mcp":
				return serverMode === "server" ? <ServerMcpSettings /> : null;
			case "server-needs-you":
				return serverMode === "server" ? <ServerNeedsYouSettings /> : null;
			case "server-collaboration":
				return serverMode === "server" ? <CollaborationSettings /> : null;
			default:
				return null;
		}
	};

	const renderContent = () => {
		if (activeTopLevel === "app") {
			return renderAppSection();
		}
		// ProjectSettingsContent already renders a proper, translated empty
		// state when `project` is undefined (first run before any project is
		// selected, or a stale selection) — no need to special-case it here
		// with a raw debug message.
		return (
			<ProjectSettingsContent
				project={selectedProject}
				activeSection={projectSection}
				isOpen={open}
				onHookReady={handleProjectHookReady}
			/>
		);
	};

	// Une recherche ne survit pas à la fermeture du dialogue : le filtre décrit
	// ce qu'on cherchait à cet instant, pas un réglage de la navigation.
	useEffect(() => {
		if (!open) {
			setSearchQuery("");
			setIsSearchOpen(false);
		}
	}, [open]);

	const closeSearch = useCallback(() => {
		setSearchQuery("");
		setIsSearchOpen(false);
	}, []);

	// The group of the page on screen: its title is the kicker above the page.
	const activeTheme = themeOfSection(
		SETTINGS_THEMES,
		activeTopLevel === "app" ? appSection : projectSection,
	);
	const pageContext = { kicker: activeTheme?.title, tone: activeTheme?.tone };

	const isSearching = searchQuery.trim().length > 0;
	const filteredThemes = filterSettingsThemes(SETTINGS_THEMES, searchQuery);

	// Correction : on force le dialog à s'ouvrir si forceDialogOpen est true
	const dialogOpen = typeof open === "boolean" ? open : false;

	return (
		<FullScreenDialog
			open={dialogOpen}
			onOpenChange={(newOpen) => {
				// The tour owns the dialog lifecycle while running.
				if (!newOpen && isTourActive) return;
				if (!newOpen) {
					revertTheme();
				}
				onOpenChange(newOpen);
			}}
		>
			<FullScreenDialogContent
				className="wp-scope"
				onEscapeKeyDown={(event) => {
					// Échap vide d'abord le filtre, et ne ferme les paramètres
					// qu'ensuite. Radix écoute le clavier en phase de capture,
					// sur le document : c'est le seul endroit d'où la touche
					// peut lui être reprise. Et seulement quand le champ a le
					// focus — Échap depuis un formulaire de réglages ferme le
					// dialogue, comme partout ailleurs.
					if (
						isSearchOpen &&
						document.activeElement === searchInputRef.current
					) {
						event.preventDefault();
						closeSearch();
					}
				}}
			>
				<FullScreenDialogHeader className="flex-row items-center gap-3 space-y-0 border-dashed">
					<span className="wp-empty-glyph h-9 w-9 shrink-0" aria-hidden="true">
						<Settings className="h-4 w-4" />
					</span>
					<div className="wp-header-text">
						<span className="wp-kicker">{t("kicker")}</span>
						<FullScreenDialogTitle className="wp-title wp-title-lg">
							{t("title")}
						</FullScreenDialogTitle>
						<FullScreenDialogDescription className="wp-header-desc">
							{t("headerDescription")}
						</FullScreenDialogDescription>
					</div>
				</FullScreenDialogHeader>
				<FullScreenDialogBody>
					<div className="flex h-full">
						{/* Navigation sidebar */}
						<nav
							className={cn(
								"wp-nav transition-all duration-300",
								isNavigationCollapsed ? "w-16 p-2" : "w-80 p-4",
							)}
						>
							<ScrollArea className="h-full">
								<div className="space-y-4">
									{/* Toggle + barre de filtre */}
									<div
										className={cn(
											"flex items-center gap-1",
											isNavigationCollapsed ? "justify-center" : "justify-end",
										)}
									>
										{/* Filtre — uniquement quand la navigation est dépliée :
										    repliée, elle n'affiche plus les libellés sur
										    lesquels le filtre porte. */}
										{!isNavigationCollapsed && (
											<div
												className={cn(
													"flex items-center overflow-hidden rounded-md transition-all duration-300 ease-in-out",
													isSearchOpen
														? "flex-1 bg-muted/50 border border-border"
														: "flex-none",
												)}
											>
												{isSearchOpen ? (
													<div className="relative flex items-center w-full">
														<Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
														<input
															ref={searchInputRef}
															type="text"
															value={searchQuery}
															onChange={(e) => setSearchQuery(e.target.value)}
															onBlur={() => {
																if (!searchQuery.trim()) {
																	setIsSearchOpen(false);
																}
															}}
															placeholder={t("search.placeholder")}
															aria-label={t("search.placeholder")}
															className="w-full bg-transparent pl-7 pr-7 py-1 text-sm placeholder:text-muted-foreground/60 focus:outline-none"
														/>
														{searchQuery && (
															<button
																type="button"
																onMouseDown={(e) => e.preventDefault()}
																onClick={() => {
																	setSearchQuery("");
																	searchInputRef.current?.focus();
																}}
																className="absolute right-1.5 text-muted-foreground hover:text-foreground transition-colors"
																aria-label={t("search.clear")}
															>
																<X className="h-3.5 w-3.5" />
															</button>
														)}
													</div>
												) : (
													<button
														type="button"
														onClick={() => {
															setIsSearchOpen(true);
															requestAnimationFrame(() =>
																searchInputRef.current?.focus(),
															);
														}}
														title={t("search.placeholder")}
														aria-label={t("search.placeholder")}
														className={cn(
															"flex items-center justify-center p-2 rounded-lg transition-all",
															"hover:bg-accent/50 text-muted-foreground hover:text-foreground",
														)}
													>
														<Search className="h-4 w-4" />
													</button>
												)}
											</div>
										)}

										<button
											type="button"
											onClick={() => {
												// Replier masque les libellés : garder le filtre
												// actif cacherait des sections sans rien qui
												// l'explique.
												if (!isNavigationCollapsed) closeSearch();
												setIsNavigationCollapsed(!isNavigationCollapsed);
											}}
											className={cn(
												"flex items-center justify-center p-2 rounded-lg transition-all",
												"hover:bg-accent/50 text-muted-foreground hover:text-foreground",
												isNavigationCollapsed ? "w-full" : "shrink-0",
											)}
										>
											<ChevronRight
												className={cn(
													"h-4 w-4 transition-transform duration-300",
													isNavigationCollapsed ? "rotate-0" : "rotate-180",
												)}
											/>
										</button>
									</div>

									{/* Getting started — opens the guided Setup Hub. Sits at the
									    very top so the configuration flow reads top-to-bottom.
									    Retiré pendant un filtrage : ce n'est pas un résultat, et
									    le laisser rendrait « aucun paramètre trouvé » ambigu. */}
									{onOpenSetupHub && !isSearching && (
										<button
											type="button"
											onClick={() => {
												onOpenChange(false);
												onOpenSetupHub();
											}}
											title={t("setupHub:navLabel")}
											className={cn(
												"wp-card wp-rail wp-tone-accent w-full flex items-center transition-all hover:bg-primary/10",
												isNavigationCollapsed
													? "justify-center p-2"
													: "gap-3 p-3",
											)}
										>
											<Compass className="h-5 w-5 shrink-0" />
											{!isNavigationCollapsed && (
												<div className="min-w-0 text-left">
													<div className="font-medium text-sm">
														{t("setupHub:navLabel")}
													</div>
													<div className="wp-meta truncate">
														{t("setupHub:navDescription")}
													</div>
												</div>
											)}
										</button>
									)}

									{/* Thematic Navigation */}
									{filteredThemes.map(([themeKey, theme]) => {
										const Icon = theme.icon;
										const tone = toneClass(
											SETTINGS_THEMES[themeKey as SettingsTheme].tone,
										);
										const isThemeActive = theme.sections.some((section) => {
											if (section.type === "app") {
												return (
													activeTopLevel === "app" && appSection === section.id
												);
											} else {
												return (
													activeTopLevel === "project" &&
													projectSection === section.id
												);
											}
										});

										return (
											<div key={themeKey} className={cn("space-y-1", tone)}>
												{/* Theme Header */}
												{isNavigationCollapsed ? (
													<button
														type="button"
														onClick={() => {
															if (theme.sections.length === 1) {
																const section = theme.sections[0];
																if (section.type === "app") {
																	setActiveTopLevel("app");
																	setAppSection(section.id as AppSection);
																} else {
																	setActiveTopLevel("project");
																	setProjectSection(
																		section.id as ProjectSettingsSection,
																	);
																}
															} else {
																// Si plusieurs sections, on pourrait développer ou afficher un menu
																// Pour l'instant, on navigue vers la première section
																const firstSection = theme.sections[0];
																if (firstSection.type === "app") {
																	setActiveTopLevel("app");
																	setAppSection(firstSection.id as AppSection);
																} else {
																	setActiveTopLevel("project");
																	setProjectSection(
																		firstSection.id as ProjectSettingsSection,
																	);
																}
															}
														}}
														className={cn(
															"w-full flex flex-col items-center justify-center p-2 rounded-lg transition-all",
															isThemeActive
																? "bg-accent text-accent-foreground"
																: "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
														)}
														title={theme.title}
													>
														<Icon className="wp-ink h-5 w-5" />
													</button>
												) : (
													<div className="px-3 py-2">
														<button
															type="button"
															onClick={() =>
																toggleThemeCollapse(themeKey as SettingsTheme)
															}
															className={cn(
																"wp-kicker w-full flex items-center justify-between transition-all",
																!isThemeActive && "opacity-80 hover:opacity-100",
															)}
														>
															<div className="flex items-center gap-2">
																<Icon className="h-3.5 w-3.5" />
																{theme.title}
															</div>
															<ChevronRight
																className={cn(
																	"h-3 w-3 transition-transform duration-200",
																	!isSearching &&
																		collapsedThemes.has(
																			themeKey as SettingsTheme,
																		)
																		? "rotate-0"
																		: "rotate-90",
																)}
															/>
														</button>
														<div className="wp-muted mt-1 text-xs">
															{theme.description}
														</div>
													</div>
												)}

												{/* Theme Sections — visibles si la navigation est
													    dépliée et que le thème l'est aussi. Une
													    recherche en cours déplie : masquer ce qu'elle
													    vient de trouver n'aurait aucun sens. */}
												{!isNavigationCollapsed &&
													(isSearching ||
														!collapsedThemes.has(
															themeKey as SettingsTheme,
														)) && (
														<div className="space-y-1 ml-2">
															{theme.sections.map((section) => {
																const SectionIcon = section.icon;
																const isActive =
																	section.type === "app"
																		? activeTopLevel === "app" &&
																			appSection === section.id
																		: activeTopLevel === "project" &&
																			projectSection === section.id;

																const isDisabled =
																	section.type === "project" &&
																	!selectedProjectId;

																return (
																	<button
																		type="button"
																		key={section.id}
																		onClick={() => {
																			if (section.type === "app") {
																				setActiveTopLevel("app");
																				setAppSection(section.id as AppSection);
																			} else {
																				setActiveTopLevel("project");
																				setProjectSection(
																					section.id as ProjectSettingsSection,
																				);
																			}
																		}}
																		disabled={isDisabled}
																		aria-current={isActive ? "page" : undefined}
																		className="wp-navitem"
																	>
																		<SectionIcon className="h-4 w-4 shrink-0" />
																		<span className="min-w-0 truncate">
																			{section.label}
																		</span>
																	</button>
																);
															})}
														</div>
													)}
											</div>
										);
									})}

									{isSearching &&
										!isNavigationCollapsed &&
										filteredThemes.length === 0 && (
											<div className="wp-meta px-3 py-6 text-center">
												{t("search.noResults")}
											</div>
										)}

									{/* Re-run Wizard button - seulement si non replié, et
									    hors filtrage, pour la même raison que le Setup Hub */}
									{!isNavigationCollapsed && !isSearching && onRerunWizard && (
										<div className="pt-4 border-t border-dashed border-border">
											<button
												type="button"
												onClick={() => {
													onOpenChange(false);
													onRerunWizard();
												}}
												className="wp-navitem items-start gap-3 border-dashed border-border p-3"
											>
												<Sparkles className="h-5 w-5 mt-0.5 shrink-0" />
												<div className="min-w-0">
													<div className="wp-title text-sm">
														{t("actions.rerunWizard")}
													</div>
													<div className="wp-meta truncate">
														{t("actions.rerunWizardDescription")}
													</div>
												</div>
											</button>
										</div>
									)}
								</div>
							</ScrollArea>
						</nav>

						{/* Main content */}
						<ModuleStage className="flex-1">
							<ScrollArea className="relative z-[1] h-full">
								<div
									className={cn(
										"p-8",
										// Sections that lay out two columns of their own need the
										// full pane; capping them at max-w-2xl squeezed both
										// columns until their content overlapped.
										!WIDE_APP_SECTIONS.has(appSection) && "max-w-2xl",
									)}
								>
									<SettingsPageContext.Provider value={pageContext}>
										{renderContent()}
									</SettingsPageContext.Provider>
								</div>
							</ScrollArea>
						</ModuleStage>
					</div>
				</FullScreenDialogBody>

				<FullScreenDialogFooter className="border-dashed">
					{(error || projectError) && (
						<Notice tone="red" icon={AlertTriangle} role="alert" className="flex-1">
							{error || projectError}
						</Notice>
					)}
					<Button variant="outline" onClick={handleCancel}>
						{t("common:buttons.cancel", "Cancel")}
					</Button>
					<Button
						onClick={handleSave}
						disabled={
							isSaving ||
							(activeTopLevel === "project" && projectSettingsHook?.isSaving)
						}
					>
						{isSaving ||
						(activeTopLevel === "project" && projectSettingsHook?.isSaving) ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("common:buttons.saving", "Saving...")}
							</>
						) : (
							<>
								<Save className="mr-2 h-4 w-4" />
								{t("actions.save")}
							</>
						)}
					</Button>
				</FullScreenDialogFooter>
			</FullScreenDialogContent>
		</FullScreenDialog>
	);
}
