import { useEffect, useRef, useState } from "react";
import type {
	AutoBuildVersionInfo,
	AzureDevOpsSyncStatus,
	InitializationBlocker,
	GitHubSyncStatus,
	GitLabSyncStatus,
	LinearSyncStatus,
	Project,
	ProjectEnvConfig,
	ProjectSettings as ProjectSettingsType,
} from "../../../../shared/types";
import type { LoadedProjectEnv } from "../../../hooks";
import { checkGitHubConnection as checkGitHubConnectionGlobal } from "../../../stores/github";
import { setProjectEnvConfig } from "../../../stores/project-env-store";
import {
	checkProjectVersion,
	initializeProject,
	refreshProjects,
	updateProjectSettings,
} from "../../../stores/project-store";

export interface UseProjectSettingsReturn {
	// Settings state
	settings: ProjectSettingsType;
	setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
	isSaving: boolean;
	error: string | null;
	setError: React.Dispatch<React.SetStateAction<string | null>>;

	// Version info
	versionInfo: AutoBuildVersionInfo | null;
	isCheckingVersion: boolean;
	isUpdating: boolean;

	// Environment config
	envConfig: ProjectEnvConfig | null;
	setEnvConfig: React.Dispatch<React.SetStateAction<ProjectEnvConfig | null>>;
	isLoadingEnv: boolean;
	envError: string | null;
	setEnvError: React.Dispatch<React.SetStateAction<string | null>>;
	updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => Promise<void>;

	// Password visibility toggles
	showClaudeToken: boolean;
	setShowClaudeToken: React.Dispatch<React.SetStateAction<boolean>>;
	showLinearKey: boolean;
	setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
	showGitHubToken: boolean;
	setShowGitHubToken: React.Dispatch<React.SetStateAction<boolean>>;

	// Collapsible sections
	expandedSections: Record<string, boolean>;
	toggleSection: (section: string) => void;

	// GitHub state
	gitHubConnectionStatus: GitHubSyncStatus | null;
	isCheckingGitHub: boolean;

	// GitLab state
	showGitLabToken: boolean;
	setShowGitLabToken: React.Dispatch<React.SetStateAction<boolean>>;
	gitLabConnectionStatus: GitLabSyncStatus | null;
	isCheckingGitLab: boolean;

	// Claude auth state
	isCheckingClaudeAuth: boolean;
	claudeAuthStatus:
		| "checking"
		| "authenticated"
		| "not_authenticated"
		| "error";
	setClaudeAuthStatus: React.Dispatch<
		React.SetStateAction<
			"checking" | "authenticated" | "not_authenticated" | "error"
		>
	>;

	// Linear state
	showLinearImportModal: boolean;
	setShowLinearImportModal: React.Dispatch<React.SetStateAction<boolean>>;
	linearConnectionStatus: LinearSyncStatus | null;
	isCheckingLinear: boolean;

	// Azure DevOps state
	showAzureDevOpsToken: boolean;
	setShowAzureDevOpsToken: React.Dispatch<React.SetStateAction<boolean>>;
	showAzureDevOpsImportModal: boolean;
	setShowAzureDevOpsImportModal: React.Dispatch<React.SetStateAction<boolean>>;
	azureDevOpsConnectionStatus: AzureDevOpsSyncStatus | null;
	isCheckingAzureDevOps: boolean;

	// Why the last initialization attempt could not proceed, when the reason is
	// one the settings screen can act on rather than only report.
	initBlocker: InitializationBlocker | null;
	isRepairingGit: boolean;

	// Actions
	handleInitialize: () => Promise<void>;
	/** `identity`: the git name/email asked for after a `git-identity-missing` blocker. */
	handleRepairGit: (identity?: { name: string; email: string }) => Promise<void>;
	handleClaudeSetup: () => Promise<void>;
	handleSave: (onClose: () => void) => Promise<void>;
}

export function useProjectSettings(
	project: Project,
	open: boolean,
): UseProjectSettingsReturn {
	const [settings, setSettings] = useState<ProjectSettingsType>(
		project.settings,
	);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [versionInfo, setVersionInfo] = useState<AutoBuildVersionInfo | null>(
		null,
	);
	const [isCheckingVersion, setIsCheckingVersion] = useState(false);
	const [isUpdating, setIsUpdating] = useState(false);
	const [initBlocker, setInitBlocker] = useState<InitializationBlocker | null>(
		null,
	);
	const [isRepairingGit, setIsRepairingGit] = useState(false);

	// Environment configuration state
	// NOTE: We maintain local envConfig state AND update the global project-env-store.
	// This dual-state pattern is intentional:
	// - Local state: allows dialog-scoped edits, immediate UI feedback
	// - Global store: syncs to Sidebar and other components for real-time updates
	// The local state is the source of truth for this dialog's edits.
	const [envConfig, setEnvConfig] = useState<ProjectEnvConfig | null>(null);
	const [isLoadingEnv, setIsLoadingEnv] = useState(false);
	const [envError, setEnvError] = useState<string | null>(null);
	// Ref to track the latest committed config - used to handle concurrent updateEnvConfig calls
	// This ensures rapid updates don't lose changes due to stale state reads.
	// It carries the project it was read for: a save sends the whole
	// configuration, so one built on another project's base would write that
	// project's settings — its repository, its tokens — into this one's file.
	// See hooks/useProjectEnvConfig, which binds the same way for the MCP page.
	const committedEnvConfigRef = useRef<LoadedProjectEnv | null>(null);

	// Password visibility toggles
	const [showClaudeToken, setShowClaudeToken] = useState(false);
	const [showLinearKey, setShowLinearKey] = useState(false);

	// Collapsible sections
	const [expandedSections, setExpandedSections] = useState<
		Record<string, boolean>
	>({
		claude: true,
		linear: false,
		github: false,
	});

	// GitHub state
	const [showGitHubToken, setShowGitHubToken] = useState(false);

	// GitLab state
	const [showGitLabToken, setShowGitLabToken] = useState(false);

	// Claude auth state
	const [isCheckingClaudeAuth, setIsCheckingClaudeAuth] = useState(false);
	const [claudeAuthStatus, setClaudeAuthStatus] = useState<
		"checking" | "authenticated" | "not_authenticated" | "error"
	>("checking");

	// Linear import state
	const [showLinearImportModal, setShowLinearImportModal] = useState(false);

	// Azure DevOps state
	const [showAzureDevOpsToken, setShowAzureDevOpsToken] = useState(false);
	const [showAzureDevOpsImportModal, setShowAzureDevOpsImportModal] =
		useState(false);

	// Reset settings when project changes
	useEffect(() => {
		setSettings(project.settings);
	}, [project]);

	// Check version when dialog opens
	useEffect(() => {
		let stale = false;
		const checkVersion = async () => {
			if (open && project.autoBuildPath) {
				setIsCheckingVersion(true);
				const result = await checkProjectVersion(project.id);
				if (stale) return;
				if (result.success && result.data) {
					setVersionInfo(result.data);
				} else {
					setVersionInfo(null);
				}
				setIsCheckingVersion(false);
			}
		};
		void checkVersion();
		return () => {
			stale = true;
		};
	}, [open, project.id, project.autoBuildPath]);

	// Load environment config when dialog opens
	useEffect(() => {
		// Another project, or the dialog closed, while this was out: the
		// answer is not the configuration on screen.
		let stale = false;
		// The last project's configuration is not this one's, even while it loads.
		if (committedEnvConfigRef.current?.projectId !== project.id) {
			committedEnvConfigRef.current = null;
			setEnvConfig(null);
		}
		const loadEnvConfig = async () => {
			if (open && project.autoBuildPath) {
				setIsLoadingEnv(true);
				setEnvError(null);
				try {
					const result = await window.electronAPI.getProjectEnv(project.id);
					if (stale) return;
					if (result.success && result.data) {
						setEnvConfig(result.data);
						committedEnvConfigRef.current = {
							projectId: project.id,
							config: result.data,
						};
						// Update the shared store so other components (like Sidebar) can react
						setProjectEnvConfig(project.id, result.data);
					} else {
						setEnvError(result.error || "Failed to load environment config");
					}
				} catch (err) {
					if (!stale) {
						setEnvError(err instanceof Error ? err.message : "Unknown error");
					}
				} finally {
					if (!stale) setIsLoadingEnv(false);
				}
			}
		};
		void loadEnvConfig();
		return () => {
			stale = true;
		};
	}, [open, project.id, project.autoBuildPath]);

	// Check Claude authentication status
	useEffect(() => {
		let stale = false;
		const checkAuth = async () => {
			if (open && project.autoBuildPath) {
				setIsCheckingClaudeAuth(true);
				try {
					const result = await window.electronAPI.checkClaudeAuth(project.id);
					if (stale) return;
					if (result.success && result.data) {
						setClaudeAuthStatus(
							result.data.authenticated ? "authenticated" : "not_authenticated",
						);
					} else {
						setClaudeAuthStatus("error");
					}
				} catch {
					if (!stale) setClaudeAuthStatus("error");
				} finally {
					if (!stale) setIsCheckingClaudeAuth(false);
				}
			}
		};
		void checkAuth();
		return () => {
			stale = true;
		};
	}, [open, project.id, project.autoBuildPath]);

	// Check each integration only while its configuration is complete.
	// The hook also discards stale responses and clears status when disabled.
	const [linearConnectionStatus, isCheckingLinear] = useConnectionCheck(
		Boolean(envConfig?.linearEnabled && envConfig.linearApiKey),
		[project.id, envConfig?.linearApiKey],
		async (projectId) => {
			const result = await window.electronAPI.checkLinearConnection(projectId);
			return result.success ? result.data : undefined;
		},
	);

	const [azureDevOpsConnectionStatus, isCheckingAzureDevOps] = useConnectionCheck(
		Boolean(
			envConfig?.azureDevOpsEnabled &&
			envConfig.azureDevOpsPat &&
			envConfig.azureDevOpsOrgUrl,
		),
		[project.id, envConfig?.azureDevOpsPat, envConfig?.azureDevOpsOrgUrl],
		async (projectId) => {
			const result = await window.electronAPI.checkAzureDevOpsConnection(projectId);
			return result.success ? result.data : undefined;
		},
	);

	// Use the global action so the GitHub Issues page receives the same status.
	const [gitHubConnectionStatus, isCheckingGitHub] = useConnectionCheck(
		Boolean(envConfig?.githubEnabled && envConfig.githubToken && envConfig.githubRepo),
		[project.id, envConfig?.githubToken, envConfig?.githubRepo],
		(projectId) => checkGitHubConnectionGlobal(projectId),
	);

	const [gitLabConnectionStatus, isCheckingGitLab] = useConnectionCheck(
		Boolean(envConfig?.gitlabEnabled && envConfig.gitlabToken && envConfig.gitlabProject),
		[project.id, envConfig?.gitlabToken, envConfig?.gitlabProject],
		async (projectId) => {
			const result = await window.electronAPI.checkGitLabConnection(projectId);
			return result.success ? result.data : undefined;
		},
	);

	

	const toggleSection = (section: string) => {
		setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
	};

	const handleInitialize = async () => {
		setIsUpdating(true);
		setError(null);
		setInitBlocker(null);
		try {
			const result = await initializeProject(project.id);
			if (result?.success) {
				// The main process wrote `.workpilot/` and stamped `autoBuildPath`
				// on the stored record; the renderer still holds the pre-init copy.
				// Without this the pane keeps claiming "Not Initialized" — and every
				// section gated on `autoBuildPath` stays hidden — until the dialog is
				// closed and reopened.
				await refreshProjects();
				const versionResult = await checkProjectVersion(project.id);
				if (versionResult.success && versionResult.data) {
					setVersionInfo(versionResult.data);
				} else {
					setVersionInfo(null);
				}
				const envResult = await window.electronAPI.getProjectEnv(project.id);
				if (envResult.success && envResult.data) {
					setEnvConfig(envResult.data);
					committedEnvConfigRef.current = {
						projectId: project.id,
						config: envResult.data,
					};
					// Update global store so Sidebar reflects correct GitHub/GitLab enabled state
					setProjectEnvConfig(project.id, envResult.data);
				}
			} else {
				// A blocker the screen knows how to walk the user out of is shown
				// as a recovery card, not as a raw error line — so it is recorded
				// instead of the message, and only the rest falls through to the
				// generic error display.
				const blocker = result?.data?.blocker ?? null;
				setInitBlocker(blocker);
				if (!blocker) {
					setError(result?.error || "Failed to initialize");
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsUpdating(false);
		}
	};

	/**
	 * Make the repository buildable, then finish what the user asked for.
	 *
	 * `initializeGit` creates the repository and/or the first commit — the two
	 * blockers that stopped initialization — and the WorkPilot AI initialization
	 * is retried straight away, because "prepare git" was never the goal: the
	 * user clicked a button that said initialize.
	 */
	const handleRepairGit = async (identity?: { name: string; email: string }) => {
		setIsRepairingGit(true);
		setError(null);
		try {
			const result = await window.electronAPI.initializeGit(
				project.path,
				undefined,
				identity,
			);
			if (!result?.success && result?.data?.blocker === "git-identity-missing") {
				// A fresh machine: the panel now asks for the name and email.
				setInitBlocker("git-identity-missing");
				return;
			}
			if (!result?.success) {
				setError(result?.error || "Failed to prepare the git repository");
				return;
			}
			setInitBlocker(null);
			await handleInitialize();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsRepairingGit(false);
		}
	};

	const handleClaudeSetup = async () => {
		setIsCheckingClaudeAuth(true);
		try {
			const result = await window.electronAPI.invokeClaudeSetup(project.id);
			if (result.success && result.data?.authenticated) {
				setClaudeAuthStatus("authenticated");
				const envResult = await window.electronAPI.getProjectEnv(project.id);
				if (envResult.success && envResult.data) {
					setEnvConfig(envResult.data);
					committedEnvConfigRef.current = {
						projectId: project.id,
						config: envResult.data,
					};
					// Update global store so Sidebar and other components reflect changes
					setProjectEnvConfig(project.id, envResult.data);
				}
			}
		} catch {
			setClaudeAuthStatus("error");
		} finally {
			setIsCheckingClaudeAuth(false);
		}
	};

	const handleSave = async (onClose: () => void) => {
		setIsSaving(true);
		setError(null);

		try {
			const success = await updateProjectSettings(project.id, settings);
			if (!success) {
				setError("Failed to save settings");
				return;
			}

			// Only a configuration read for this project is written to it.
			if (envConfig && committedEnvConfigRef.current?.projectId === project.id) {
				const envResult = await window.electronAPI.updateProjectEnv(
					project.id,
					envConfig,
				);
				if (!envResult.success) {
					setError(envResult.error || "Failed to save environment config");
					return;
				}
			}

			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsSaving(false);
		}
	};

	const updateEnvConfig = async (updates: Partial<ProjectEnvConfig>) => {
		// Use the committed ref as base to handle concurrent calls correctly
		// This ensures rapid updates don't lose changes due to stale state reads
		const loaded = committedEnvConfigRef.current;
		if (!loaded || loaded.projectId !== project.id) {
			// Nothing was read for this project yet, or the dialog moved to
			// another project while this field was losing focus. Saving would
			// write a partial configuration, or the previous project's, here;
			// the load that is already running provides this project's base.
			console.warn(
				"[useProjectSettings] no configuration loaded for this project — skipping save. Updates:",
				updates,
			);
			return;
		}

		const newConfig = { ...loaded.config, ...updates };

		// OPTIMISTIC UPDATES: Update local state IMMEDIATELY for responsive UI
		// This ensures the user sees their changes reflected instantly
		setEnvConfig(newConfig);

		// Update the ref BEFORE the await (optimistically) to prevent race conditions
		// If two calls happen rapidly, the second will see the first's changes in the ref
		committedEnvConfigRef.current = { projectId: project.id, config: newConfig };

		// Update the shared store so other components (like Sidebar) can react immediately
		setProjectEnvConfig(project.id, newConfig);

		// Save to backend asynchronously
		try {
			const result = await window.electronAPI.updateProjectEnv(
				project.id,
				newConfig,
			);
			if (!result.success) {
				console.error(
					"[useProjectSettings] Failed to auto-save env config:",
					result.error,
				);
				setEnvError(result.error || "Failed to save environment config");
				// Note: We don't rollback the optimistic update because another concurrent call may have
				// already updated it. The error is shown to the user who can retry.
				return;
			}
		} catch (err) {
			console.error("[useProjectSettings] Error auto-saving env config:", err);
			setEnvError(
				err instanceof Error
					? err.message
					: "Failed to save environment config",
			);
			// Note: We don't rollback the optimistic update for the same reason as above.
			return;
		}

		// Clear any previous error on successful save
		setEnvError(null);
	};

	return {
		settings,
		setSettings,
		isSaving,
		error,
		setError,
		versionInfo,
		isCheckingVersion,
		isUpdating,
		envConfig,
		setEnvConfig,
		isLoadingEnv,
		envError,
		setEnvError,
		updateEnvConfig,
		showClaudeToken,
		setShowClaudeToken,
		showLinearKey,
		setShowLinearKey,
		showGitHubToken,
		setShowGitHubToken,
		expandedSections,
		toggleSection,
		gitHubConnectionStatus,
		isCheckingGitHub,
		showGitLabToken,
		setShowGitLabToken,
		gitLabConnectionStatus,
		isCheckingGitLab,
		isCheckingClaudeAuth,
		claudeAuthStatus,
		setClaudeAuthStatus,
		showLinearImportModal,
		setShowLinearImportModal,
		linearConnectionStatus,
		isCheckingLinear,
		showAzureDevOpsToken,
		setShowAzureDevOpsToken,
		showAzureDevOpsImportModal,
		setShowAzureDevOpsImportModal,
		azureDevOpsConnectionStatus,
		isCheckingAzureDevOps,
		initBlocker,
		isRepairingGit,
		handleInitialize,
		handleRepairGit,
		handleClaudeSetup,
		handleSave,
	};
}

/**
 * A connection's status, checked while `ready` and again whenever the project
 * or the settings it depends on change; nothing while not ready. An answer for
 * settings that changed in the meantime (another project, another token) is
 * dropped.
 */
function useConnectionCheck<T extends { connected: boolean; error?: string }>(
	ready: boolean,
	inputs: readonly [projectId: string, ...settings: Array<string | undefined>],
	check: (projectId: string) => Promise<T | null | undefined>,
): [T | null, boolean] {
	const [status, setStatus] = useState<T | null>(null);
	const [checking, setChecking] = useState(false);
	const checkRef = useRef(check);
	checkRef.current = check;
	const key = JSON.stringify(inputs);

	useEffect(() => {
		setStatus(null);
		if (!ready) {
			setChecking(false);
			return;
		}
		let stale = false;
		setChecking(true);
		// The project the inputs name, read from the same text the effect
		// depends on: a new array each render, the same text.
		const [projectId] = JSON.parse(key) as [string];
		checkRef
			.current(projectId)
			.then((result) => {
				if (!stale && result) setStatus(result);
			})
			.catch(() => {
				if (!stale) {
					setStatus({ connected: false, error: "Failed to check connection" } as T);
				}
			})
			.finally(() => {
				if (!stale) setChecking(false);
			});
		return () => {
			stale = true;
		};
	}, [ready, key]);

	return [status, checking];
}
