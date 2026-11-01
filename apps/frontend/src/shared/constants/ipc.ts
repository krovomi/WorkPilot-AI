/**
 * IPC Channel names for Electron communication
 * Main process <-> Renderer process communication
 */

export const IPC_CHANNELS = {
	DICTATION_START: "dictation:start",
	DICTATION_TRANSCRIBE: "dictation:transcribe",
	DICTATION_CANCEL: "dictation:cancel",
	JEV_STATUS: "jev:status",
	JEV_SAVE_KEY: "jev:saveKey",
	JEV_CLEAR_KEY: "jev:clearKey",
	// Secrets at rest: is the OS keyring protecting stored API keys / tokens?
	SECURE_STORAGE_STATUS: "secureStorage:status",
	SECURE_STORAGE_STATUS_CHANGED: "secureStorage:statusChanged", // main → renderer
	// Project operations
	PROJECT_ADD: "project:add",
	PROJECT_REMOVE: "project:remove",
	PROJECT_LIST: "project:list",
	PROJECT_UPDATE_SETTINGS: "project:updateSettings",
	PROJECT_RENAME: "project:rename",
	PROJECT_INITIALIZE: "project:initialize",
	PROJECT_CHECK_VERSION: "project:checkVersion",
	PROJECT_CHECK_PATHS: "project:checkPaths",
	PROJECT_REPATH: "project:repath",

	// Tab state operations (persisted in main process)
	TAB_STATE_GET: "tabState:get",
	TAB_STATE_SAVE: "tabState:save",

	// Kanban preferences (per-project column collapse state)
	KANBAN_PREFS_GET: "kanbanPrefs:get",
	KANBAN_PREFS_SAVE: "kanbanPrefs:save",
	// Kanban board view-state (per-project column order, filters, saved views)
	KANBAN_STATE_GET: "kanbanState:get",
	KANBAN_STATE_SAVE: "kanbanState:save",

	// Task operations
	TASK_LIST: "task:list",
	TASK_CREATE: "task:create",
	TASK_DUPLICATE: "task:duplicate", // Clone a task's spec (spec.md, requirements, metadata, attachments) into a fresh backlog task; no plan/worktree/runtime artifacts
	TASK_DELETE: "task:delete",
	TASK_UPDATE: "task:update",
	TASK_START: "task:start",
	TASK_STOP: "task:stop",
	TASK_REVIEW: "task:review",
	TASK_UPDATE_STATUS: "task:updateStatus",
	TASK_UPDATE_PLAN: "task:updatePlan", // Update plan phases and subtasks
	TASK_RECOVER_STUCK: "task:recoverStuck",
	TASK_CHECK_RUNNING: "task:checkRunning",
	TASK_RESUME_PAUSED: "task:resumePaused", // Resume a rate-limited or auth-paused task
	TASK_RESUME_SESSION: "task:resumeSession", // Resume a Claude SDK session (uses .session.json)
	TASK_RESUME_WITH_PROVIDER: "task:resumeWithProvider", // Resume a paused task under a different LLM provider (Niveau 3b)
	TASK_RESET_CONVERSATION: "task:resetConversation", // Clear conversation.jsonl + PROMPT_TOO_LONG_HALT marker so the task can restart with a fresh context
	TASK_RESET: "task:reset", // Full reset: discard plan/subtasks, worktree and runtime artifacts; keep the spec and go back to backlog
	TASK_RERUN_PHASE: "task:rerunPhase", // Re-run one execution phase on demand (planning/coding/validation); cascade-invalidates downstream phases and restarts
	TASK_HOT_SWAP: "task:hotSwap", // Live provider/model/effort change during a running phase (applied at the next turn, context replayed)
	TASK_CONTEXT_ACTION: "task:contextAction", // One-shot compact/clear of the running session's context (writes CONTEXT_ACTION.json in every spec dir copy)
	TASK_CONTEXT_POLICY_UPDATE: "task:contextPolicyUpdate", // Merge `contextPolicy` into task_metadata.json of every spec dir copy (main + worktree) — read live by the backend
	TASK_SANDBOX_STATUS: "task:sandboxStatus", // Event (main -> renderer): whether a task's commands run in the OS sandbox (SANDBOX_STATUS)
	TASK_SANDBOX_LIST: "task:sandboxList", // The sandbox statuses main holds, for a reloaded renderer
	TASK_GOAL_GET: "task:goalGet", // The task's goal (goal mode), read from <spec>/.workpilot-goal.json
	TASK_GOAL_SET: "task:goalSet", // Write or remove the goal in every spec dir copy; agents cannot write that file
	TASK_CONTEXT_USAGE: "task:contextUsage", // Event (main -> renderer): CONTEXT_USAGE / CONTEXT_ACTION_APPLIED task events, forwarded untouched
	TASK_PERMISSION_REQUEST: "task:permissionRequest", // Event (main -> renderer): an ACP agent asks before it acts (PERMISSION_REQUESTED, validated)
	TASK_PERMISSION_CLEARED: "task:permissionCleared", // Event (main -> renderer): that question is answered, timed out or its process is gone
	TASK_PERMISSION_LIST: "task:permissionList", // The questions waiting now (after a reload of the renderer)
	TASK_PERMISSION_ANSWER: "task:permissionAnswer", // The person's choice, checked in main, written to the build's stdin
	TASK_CHECK_PLAN_CONFLICTS: "task:checkPlanConflicts", // Detect file overlaps between this task's plan and other active tasks (parallel worktrees)

	// CI/CD pipeline loop (« Build rouge » column) — provider-agnostic (Azure DevOps, GitHub Actions, GitLab CI, Jenkins)
	TASK_PIPELINE_STATUS_GET: "task:pipelineStatusGet", // On-demand fetch of the latest build for a task's branch
	TASK_PIPELINE_FIX: "task:pipelineFix", // Launch the agent to repair a red build (writes BUILD_FAILURE.md + fix subtask)
	TASK_PIPELINE_STATUS_EVENT: "task:pipelineStatus", // Event (main -> renderer): pipeline status changed for a task
	TASK_UPDATED_EVENT: "task:updated", // Event (main -> renderer): fields of a task changed in main (PR URL, visual proof)
	TASK_SPEC_INTERVIEW: "task:specInterview", // Generate 3-5 clarifying questions about the spec before planning (answers are appended to the description)
	TASK_LOAD_IMAGE_THUMBNAIL: "task:loadImageThumbnail",

	// Workspace management (for human review)
	// Per-spec architecture: Each spec has its own worktree at .worktrees/{spec-name}/
	TASK_WORKTREE_STATUS: "task:worktreeStatus",
	TASK_WORKTREE_DIFF: "task:worktreeDiff",
	TASK_FILE_DIFF: "task:fileDiff", // Diff à la demande d'un fichier impacté (inclut les changements non commités)
	TASK_WORKTREE_MERGE: "task:worktreeMerge",
	TASK_WORKTREE_MERGE_PREVIEW: "task:worktreeMergePreview", // Preview merge conflicts before merging
	TASK_WORKTREE_DISCARD: "task:worktreeDiscard",
	TASK_WORKTREE_DISCARD_ORPHAN: "task:worktreeDiscardOrphan", // Delete orphaned worktree by spec name (no task association)
	TASK_WORKTREE_SYNC_FROM_BRANCH: "task:worktreeSyncFromBranch", // Merge or rebase worktree from any branch
	TASK_WORKTREE_CREATE_PR: "task:worktreeCreatePR",
	TASK_WORKTREE_ANALYZE_IMPACT: "task:worktreeAnalyzeImpact", // Preview PR body + impact analysis WITHOUT pushing
	TASK_VISUAL_PROOF_RUN: "task:visualProofRun", // Run emulator + screenshot proof (PR optional)
	TASK_VISUAL_PROOF_SYNC: "task:visualProofSync", // Detect a PR on the branch and publish stored captures to it
	TASK_VISUAL_PROOF_STATUS: "task:visualProofStatus", // Query whether a visual proof run is in progress for a task
	TASK_PR_FOLLOWUP_START: "task:prFollowupStart", // Drive the task's PR to merge: fix red checks and review threads
	TASK_PR_FOLLOWUP_STOP: "task:prFollowupStop",
	TASK_PR_FOLLOWUP_STATUS: "task:prFollowupStatus", // Running or not, and the last look at the PR
	TASK_MCP_APPS_LIST: "task:mcpAppsList", // The MCP App views a build kept for the task
	TASK_MCP_APP_OPEN: "task:mcpAppOpen", // Serve one view on its own scheme, for one frame
	TASK_MCP_APP_CLOSE: "task:mcpAppClose", // The frame closed: stop serving the view
	TASK_BEST_OF_N_START: "task:bestOfNStart", // Build the task N ways, one worktree and engine each (best-of-N)
	TASK_BEST_OF_N_STATUS: "task:bestOfNStatus", // <spec>/best_of_n.json and the variants running now
	TASK_BEST_OF_N_RANK: "task:bestOfNRank", // Measure and rank the variants again
	TASK_BEST_OF_N_ADOPT: "task:bestOfNAdopt", // Make the chosen variant the task's build, remove the others
	TASK_BEST_OF_N_DISCARD: "task:bestOfNDiscard", // Stop and remove every variant
	TASK_WORKTREE_OPEN_IN_IDE: "task:worktreeOpenInIDE",
	TASK_WORKTREE_OPEN_IN_TERMINAL: "task:worktreeOpenInTerminal",
	TASK_WORKTREE_DETECT_TOOLS: "task:worktreeDetectTools", // Detect installed IDEs/terminals
	TASK_WORKTREE_READ_FILE: "task:worktreeReadFile",
	TASK_WORKTREE_WRITE_FILE: "task:worktreeWriteFile",
	TASK_WORKTREE_DELETE_FILES: "task:worktreeDeleteFiles",
	TASK_LIST_WORKTREES: "task:listWorktrees",
	TASK_ARCHIVE: "task:archive",
	TASK_UNARCHIVE: "task:unarchive",
	TASK_CLEAR_STAGED_STATE: "task:clearStagedState",

	// Task events (main -> renderer)
	TASK_PROGRESS: "task:progress",
	TASK_ERROR: "task:error",
	TASK_LOG: "task:log",
	TASK_STATUS_CHANGE: "task:statusChange",
	TASK_EXECUTION_PROGRESS: "task:executionProgress",
	TASK_VISUAL_PROOF_RUNNING: "task:visualProofRunning", // Event: visual proof run started/finished (main -> renderer)
	TASK_PR_FOLLOWUP_EVENT: "task:prFollowupEvent", // Event: a look at the PR, or the follow-through stopped (main -> renderer)
	TASK_MCP_APP_VIEW: "task:mcpAppView", // Event: a build kept a new MCP App view (main -> renderer)
	TASK_BEST_OF_N_EVENT: "task:bestOfNEvent", // Event: a variant started or ended, a ranking, an adoption (main -> renderer)

	// Task phase logs (persistent, collapsible logs by phase)
	TASK_LOGS_GET: "task:logsGet", // Load logs from spec dir
	TASK_LOGS_GET_PER_LLM: "task:logsGetPerLlm", // Load per-LLM log files (one per provider/model)
	TASK_LOGS_WATCH: "task:logsWatch", // Start watching for log changes
	TASK_LOGS_UNWATCH: "task:logsUnwatch", // Stop watching for log changes
	TASK_LOGS_CHANGED: "task:logsChanged", // Event: logs changed (main -> renderer)
	TASK_LOGS_STREAM: "task:logsStream", // Event: streaming log chunk (main -> renderer)
	TASK_MERGE_PROGRESS: "task:mergeProgress", // Event: merge progress update (main -> renderer)

	// Agent Decision Logger (Feature 30)
	AGENT_DECISION_LOG_GET: "agentDecision:getLog", // Renderer → Main: load persisted log
	AGENT_DECISION_LOG_CLEAR: "agentDecision:clearLog", // Renderer → Main: clear log file
	AGENT_DECISION_LOG_ENTRY: "agentDecision:entry", // Main → Renderer: live entry stream

	// Terminal operations
	TERMINAL_CREATE: "terminal:create",
	TERMINAL_DESTROY: "terminal:destroy",
	TERMINAL_INPUT: "terminal:input",
	TERMINAL_RESIZE: "terminal:resize",
	TERMINAL_INVOKE_CLAUDE: "terminal:invokeClaude",
	TERMINAL_GENERATE_NAME: "terminal:generateName",
	TERMINAL_SET_TITLE: "terminal:setTitle", // Renderer -> Main: user renamed terminal
	TERMINAL_SET_WORKTREE_CONFIG: "terminal:setWorktreeConfig", // Renderer -> Main: worktree association changed

	// Terminal session management
	TERMINAL_GET_SESSIONS: "terminal:getSessions",
	TERMINAL_RESTORE_SESSION: "terminal:restoreSession",
	TERMINAL_CLEAR_SESSIONS: "terminal:clearSessions",
	TERMINAL_RESUME_CLAUDE: "terminal:resumeClaude",
	TERMINAL_ACTIVATE_DEFERRED_RESUME: "terminal:activateDeferredResume", // Trigger deferred Claude resume when terminal becomes active
	TERMINAL_GET_SESSION_DATES: "terminal:getSessionDates",
	TERMINAL_GET_SESSIONS_FOR_DATE: "terminal:getSessionsForDate",
	TERMINAL_RESTORE_FROM_DATE: "terminal:restoreFromDate",
	TERMINAL_CHECK_PTY_ALIVE: "terminal:checkPtyAlive",
	TERMINAL_UPDATE_DISPLAY_ORDERS: "terminal:updateDisplayOrders", // Persist terminal display order after drag-drop reorder

	// Terminal worktree operations (isolated development in worktrees)
	TERMINAL_WORKTREE_CREATE: "terminal:worktreeCreate",
	TERMINAL_WORKTREE_REMOVE: "terminal:worktreeRemove",
	TERMINAL_WORKTREE_LIST: "terminal:worktreeList",
	TERMINAL_WORKTREE_LIST_OTHER: "terminal:worktreeListOther",

	// Terminal events (main -> renderer)
	TERMINAL_OUTPUT: "terminal:output",
	TERMINAL_EXIT: "terminal:exit",
	TERMINAL_TITLE_CHANGE: "terminal:titleChange",
	TERMINAL_WORKTREE_CONFIG_CHANGE: "terminal:worktreeConfigChange", // Worktree config restored/changed (for sync on recovery)
	TERMINAL_CLAUDE_SESSION: "terminal:claudeSession", // Claude session ID captured
	TERMINAL_PENDING_RESUME: "terminal:pendingResume", // Terminal has pending Claude resume (for deferred activation)
	TERMINAL_RATE_LIMIT: "terminal:rateLimit", // Claude Code rate limit detected
	TERMINAL_OAUTH_TOKEN: "terminal:oauthToken", // OAuth token captured from setup-token output
	TERMINAL_CLAUDE_BUSY: "terminal:claudeBusy", // Claude Code busy state (for visual indicator)
	TERMINAL_CLAUDE_EXIT: "terminal:claudeExit", // Claude Code exited (returned to shell)
	TERMINAL_ONBOARDING_COMPLETE: "terminal:onboardingComplete", // Claude onboarding complete (ready for input after login)
	TERMINAL_PROFILE_CHANGED: "terminal:profileChanged", // Profile changed, terminals need refresh (main -> renderer)

	// Claude profile management (multi-account support)
	CLAUDE_PROFILES_GET: "claude:profilesGet",
	CLAUDE_PROFILE_SAVE: "claude:profileSave",
	CLAUDE_PROFILE_DELETE: "claude:profileDelete",
	CLAUDE_PROFILE_RENAME: "claude:profileRename",
	CLAUDE_PROFILE_SET_ACTIVE: "claude:profileSetActive",
	CLAUDE_PROFILE_SWITCH: "claude:profileSwitch",
	CLAUDE_PROFILE_SET_TOKEN: "claude:profileSetToken", // Set OAuth token for a profile
	CLAUDE_PROFILE_AUTHENTICATE: "claude:profileAuthenticate", // Open visible terminal for OAuth login
	CLAUDE_PROFILE_VERIFY_AUTH: "claude:profileVerifyAuth", // Check if profile has been authenticated
	CLAUDE_PROFILE_AUTO_SWITCH_SETTINGS: "claude:autoSwitchSettings",
	CLAUDE_PROFILE_UPDATE_AUTO_SWITCH: "claude:updateAutoSwitch",
	CLAUDE_PROFILE_FETCH_USAGE: "claude:fetchUsage",
	CLAUDE_PROFILE_GET_BEST_PROFILE: "claude:getBestProfile",

	// Account priority order (unified OAuth + API profile ordering)
	ACCOUNT_PRIORITY_GET: "account:priorityGet",
	ACCOUNT_PRIORITY_SET: "account:prioritySet",

	// SDK/CLI rate limit event (for non-terminal Claude invocations)
	CLAUDE_SDK_RATE_LIMIT: "claude:sdkRateLimit",
	// Auth failure event (401 errors requiring re-authentication)
	CLAUDE_AUTH_FAILURE: "claude:authFailure",
	// Retry a rate-limited operation with a different profile
	CLAUDE_RETRY_WITH_PROFILE: "claude:retryWithProfile",

	// Usage monitoring (proactive account switching)
	COSTS_DATA_UPDATED: "costs:dataUpdated", // Event: cost_data.json changed (main -> renderer)
	DASHBOARD_SNAPSHOT_UPDATED: "dashboard:snapshotUpdated", // Event: dashboard_snapshot.json changed (main -> renderer)
	USAGE_UPDATED: "claude:usageUpdated", // Event: usage data updated (main -> renderer)
	USAGE_REQUEST: "claude:usageRequest", // Request current usage snapshot
	ALL_PROFILES_USAGE_REQUEST: "claude:allProfilesUsageRequest", // Request all profiles usage immediately
	ALL_PROFILES_USAGE_UPDATED: "claude:allProfilesUsageUpdated", // Event: all profiles usage data (main -> renderer)
	PROACTIVE_SWAP_NOTIFICATION: "claude:proactiveSwapNotification", // Event: proactive swap occurred

	// Settings
	SETTINGS_GET: "settings:get",
	SETTINGS_SAVE: "settings:save",
	NEEDS_YOU_TEST: "needsYou:test", // Send a test "needs you" to the configured remote channels; per-channel result
	NEEDS_YOU_OPEN_TASK: "needsYou:openTask", // Event (main -> renderer): a desktop notification was clicked (taskId, projectId)
	NEEDS_YOU_APPROVE_PLAN: "needsYou:approvePlan", // Event (main -> renderer): apply a remote plan approval (requestId, taskId)
	NEEDS_YOU_APPROVAL_RESULT: "needsYou:approvalResult", // invoke (renderer -> main): how that approval went (requestId, outcome)
	// Lists the custom provider's models with its stored key (main holds the key)
	SETTINGS_CUSTOM_PROVIDER_DISCOVER_MODELS: "settings:customProviderDiscoverModels",
	SETTINGS_GET_CLI_TOOLS_INFO: "settings:getCliToolsInfo",
	SETTINGS_CLAUDE_CODE_GET_ONBOARDING_STATUS:
		"settings:claudeCode:getOnboardingStatus", // Check hasCompletedOnboarding from ~/.claude.json

	// API Profile management (custom Anthropic-compatible endpoints)
	PROFILES_GET: "profiles:get",
	PROFILES_SAVE: "profiles:save",
	PROFILES_UPDATE: "profiles:update",
	PROFILES_DELETE: "profiles:delete",
	PROFILES_SET_ACTIVE: "profiles:setActive",
	PROFILES_TEST_CONNECTION: "profiles:test-connection",
	PROFILES_TEST_CONNECTION_CANCEL: "profiles:test-connection-cancel",
	PROFILES_DISCOVER_MODELS: "profiles:discover-models",
	PROFILES_DISCOVER_MODELS_CANCEL: "profiles:discover-models-cancel",

	// Dialogs
	DIALOG_SELECT_DIRECTORY: "dialog:selectDirectory",
	DIALOG_SELECT_FILES: "dialog:selectFiles",
	DIALOG_CREATE_PROJECT_FOLDER: "dialog:createProjectFolder",
	DIALOG_INSPECT_PROJECT_LOCATION: "dialog:inspectProjectLocation",
	DIALOG_GET_DEFAULT_PROJECT_LOCATION: "dialog:getDefaultProjectLocation",

	// App info
	APP_VERSION: "app:version",

	// Shell operations
	SHELL_OPEN_EXTERNAL: "shell:openExternal",
	SHELL_OPEN_TERMINAL: "shell:openTerminal",

	// Roadmap operations
	ROADMAP_GET: "roadmap:get",
	ROADMAP_GET_STATUS: "roadmap:getStatus",
	ROADMAP_SAVE: "roadmap:save",
	ROADMAP_GENERATE: "roadmap:generate",
	ROADMAP_REFRESH: "roadmap:refresh",
	ROADMAP_STOP: "roadmap:stop",
	ROADMAP_UPDATE_FEATURE: "roadmap:updateFeature",
	ROADMAP_CONVERT_TO_SPEC: "roadmap:convertToSpec",

	// Roadmap events (main -> renderer)
	ROADMAP_PROGRESS: "roadmap:progress",
	ROADMAP_COMPLETE: "roadmap:complete",
	ROADMAP_ERROR: "roadmap:error",
	ROADMAP_STOPPED: "roadmap:stopped",

	// Roadmap progress persistence (per-project state)
	ROADMAP_PROGRESS_SAVE: "roadmap:progressSave",
	ROADMAP_PROGRESS_LOAD: "roadmap:progressLoad",
	ROADMAP_PROGRESS_CLEAR: "roadmap:progressClear",

	// Context operations
	CONTEXT_GET: "context:get",
	CONTEXT_REFRESH_INDEX: "context:refreshIndex",
	CONTEXT_MEMORY_STATUS: "context:memoryStatus",
	CONTEXT_SEARCH_MEMORIES: "context:searchMemories",
	CONTEXT_GET_MEMORIES: "context:getMemories",

	// Environment configuration
	ENV_GET: "env:get",
	ENV_UPDATE: "env:update",
	ENV_CHECK_CLAUDE_AUTH: "env:checkClaudeAuth",
	ENV_INVOKE_CLAUDE_SETUP: "env:invokeClaudeSetup",
	ENV_TEST_NOTIFICATION_WEBHOOK: "env:testNotificationWebhook",

	// Ideation operations
	IDEATION_GET: "ideation:get",
	IDEATION_GENERATE: "ideation:generate",
	IDEATION_REFRESH: "ideation:refresh",
	IDEATION_STOP: "ideation:stop",
	IDEATION_UPDATE_IDEA: "ideation:updateIdea",
	IDEATION_CONVERT_TO_TASK: "ideation:convertToTask",
	IDEATION_DISMISS: "ideation:dismiss",
	IDEATION_DISMISS_ALL: "ideation:dismissAll",
	IDEATION_ARCHIVE: "ideation:archive",
	IDEATION_DELETE: "ideation:delete",
	IDEATION_DELETE_MULTIPLE: "ideation:deleteMultiple",

	// Ideation events (main -> renderer)
	IDEATION_PROGRESS: "ideation:progress",
	IDEATION_LOG: "ideation:log",
	IDEATION_COMPLETE: "ideation:complete",
	IDEATION_ERROR: "ideation:error",
	IDEATION_STOPPED: "ideation:stopped",
	IDEATION_TYPE_COMPLETE: "ideation:typeComplete",
	IDEATION_TYPE_FAILED: "ideation:typeFailed",

	// Linear integration
	LINEAR_GET_TEAMS: "linear:getTeams",
	LINEAR_GET_PROJECTS: "linear:getProjects",
	LINEAR_GET_ISSUES: "linear:getIssues",
	LINEAR_IMPORT_ISSUES: "linear:importIssues",
	LINEAR_CHECK_CONNECTION: "linear:checkConnection",

	// Azure DevOps integration
	AZURE_DEVOPS_GET_WORK_ITEMS: "azureDevOps:getWorkItems",
	AZURE_DEVOPS_GET_WORK_ITEM: "azureDevOps:getWorkItem",
	AZURE_DEVOPS_IMPORT_WORK_ITEMS: "azureDevOps:importWorkItems",
	AZURE_DEVOPS_CHECK_CONNECTION: "azureDevOps:checkConnection",
	AZURE_DEVOPS_LIST_REPOSITORIES: "azureDevOps:listRepositories",
	AZURE_DEVOPS_DETECT_REPOSITORY: "azureDevOps:detectRepository",
	AZURE_DEVOPS_SYNC_TASK_AC: "azureDevOps:syncTaskAC",
	AZURE_DEVOPS_HYDRATE_TASK_DISPLAY: "azureDevOps:hydrateTaskDisplay",

	// Azure DevOps PR Review
	AZURE_DEVOPS_PR_REVIEW: "azureDevOps:prReview",
	AZURE_DEVOPS_PR_GET_REVIEW: "azureDevOps:prGetReview",
	AZURE_DEVOPS_PR_REVIEW_CANCEL: "azureDevOps:prReviewCancel",
	AZURE_DEVOPS_PR_POST_COMMENT: "azureDevOps:prPostComment",

	// Jira integration
	JIRA_GET_ISSUES: "jira:getIssues",
	JIRA_GET_ISSUE: "jira:getIssue",
	JIRA_CHECK_CONNECTION: "jira:checkConnection",
	JIRA_TEST_CONNECTION: "jira:testConnection",
	JIRA_GET_ATTACHMENTS: "jira:getAttachments",

	// Figma: the token is written, never read back
	FIGMA_TOKEN_STATUS: "figma:tokenStatus",
	FIGMA_SET_TOKEN: "figma:setToken",

	// GitHub integration
	GITHUB_GET_REPOSITORIES: "github:getRepositories",
	GITHUB_GET_ISSUES: "github:getIssues",
	GITHUB_GET_ISSUE: "github:getIssue",
	GITHUB_GET_ISSUE_COMMENTS: "github:getIssueComments",
	GITHUB_CHECK_CONNECTION: "github:checkConnection",
	GITHUB_INVESTIGATE_ISSUE: "github:investigateIssue",
	GITHUB_IMPORT_ISSUES: "github:importIssues",
	GITHUB_CREATE_RELEASE: "github:createRelease",

	// GitHub OAuth (gh CLI authentication)
	GITHUB_CHECK_CLI: "github:checkCli",
	GITHUB_CHECK_AUTH: "github:checkAuth",
	GITHUB_START_AUTH: "github:startAuth",
	GITHUB_GET_TOKEN: "github:getToken",
	GITHUB_GET_USER: "github:getUser",
	GITHUB_LIST_USER_REPOS: "github:listUserRepos",
	GITHUB_DETECT_REPO: "github:detectRepo",
	GITHUB_GET_BRANCHES: "github:getBranches",
	GITHUB_CREATE_REPO: "github:createRepo",
	GITHUB_ADD_REMOTE: "github:addRemote",
	GITHUB_LIST_ORGS: "github:listOrgs",

	// GitHub OAuth events (main -> renderer) - for streaming device code during auth
	GITHUB_AUTH_DEVICE_CODE: "github:authDeviceCode",
	GITHUB_AUTH_CHANGED: "github:authChanged", // Event: GitHub auth state changed (account swap)

	// GitHub events (main -> renderer)
	GITHUB_INVESTIGATION_PROGRESS: "github:investigationProgress",
	GITHUB_INVESTIGATION_COMPLETE: "github:investigationComplete",
	GITHUB_INVESTIGATION_ERROR: "github:investigationError",

	// GitLab integration
	GITLAB_GET_PROJECTS: "gitlab:getProjects",
	GITLAB_GET_ISSUES: "gitlab:getIssues",
	GITLAB_GET_ISSUE: "gitlab:getIssue",
	GITLAB_GET_ISSUE_NOTES: "gitlab:getIssueNotes",
	GITLAB_CHECK_CONNECTION: "gitlab:checkConnection",
	GITLAB_INVESTIGATE_ISSUE: "gitlab:investigateIssue",
	GITLAB_IMPORT_ISSUES: "gitlab:importIssues",
	GITLAB_CREATE_RELEASE: "gitlab:createRelease",

	// GitLab Merge Requests (equivalent to GitHub PRs)
	GITLAB_GET_MERGE_REQUESTS: "gitlab:getMergeRequests",
	GITLAB_GET_MERGE_REQUEST: "gitlab:getMergeRequest",
	GITLAB_CREATE_MERGE_REQUEST: "gitlab:createMergeRequest",
	GITLAB_UPDATE_MERGE_REQUEST: "gitlab:updateMergeRequest",

	// GitLab OAuth (glab CLI authentication)
	GITLAB_CHECK_CLI: "gitlab:checkCli",
	GITLAB_INSTALL_CLI: "gitlab:installCli",
	GITLAB_CHECK_AUTH: "gitlab:checkAuth",
	GITLAB_START_AUTH: "gitlab:startAuth",
	GITLAB_GET_TOKEN: "gitlab:getToken",
	GITLAB_GET_USER: "gitlab:getUser",
	GITLAB_LIST_USER_PROJECTS: "gitlab:listUserProjects",
	GITLAB_DETECT_PROJECT: "gitlab:detectProject",
	GITLAB_GET_BRANCHES: "gitlab:getBranches",
	GITLAB_CREATE_PROJECT: "gitlab:createProject",
	GITLAB_ADD_REMOTE: "gitlab:addRemote",
	GITLAB_LIST_GROUPS: "gitlab:listGroups",

	// GitLab events (main -> renderer)
	GITLAB_INVESTIGATION_PROGRESS: "gitlab:investigationProgress",
	GITLAB_INVESTIGATION_COMPLETE: "gitlab:investigationComplete",
	GITLAB_INVESTIGATION_ERROR: "gitlab:investigationError",

	// GitLab MR Review operations
	GITLAB_MR_GET_DIFF: "gitlab:mr:getDiff",
	GITLAB_MR_REVIEW: "gitlab:mr:review",
	GITLAB_MR_REVIEW_CANCEL: "gitlab:mr:reviewCancel",
	GITLAB_MR_GET_REVIEW: "gitlab:mr:getReview",
	GITLAB_MR_FOLLOWUP_REVIEW: "gitlab:mr:followupReview",
	GITLAB_MR_POST_REVIEW: "gitlab:mr:postReview",
	GITLAB_MR_POST_NOTE: "gitlab:mr:postNote",
	GITLAB_MR_MERGE: "gitlab:mr:merge",
	GITLAB_MR_ASSIGN: "gitlab:mr:assign",
	GITLAB_MR_APPROVE: "gitlab:mr:approve",
	GITLAB_MR_CHECK_NEW_COMMITS: "gitlab:mr:checkNewCommits",

	// GitLab MR Review events (main -> renderer)
	GITLAB_MR_REVIEW_PROGRESS: "gitlab:mr:reviewProgress",
	GITLAB_MR_REVIEW_COMPLETE: "gitlab:mr:reviewComplete",
	GITLAB_MR_REVIEW_ERROR: "gitlab:mr:reviewError",

	// GitLab Auto-Fix operations
	GITLAB_AUTOFIX_START: "gitlab:autofix:start",
	GITLAB_AUTOFIX_GET_QUEUE: "gitlab:autofix:getQueue",
	GITLAB_AUTOFIX_CHECK_LABELS: "gitlab:autofix:checkLabels",
	GITLAB_AUTOFIX_CHECK_NEW: "gitlab:autofix:checkNew",
	GITLAB_AUTOFIX_GET_CONFIG: "gitlab:autofix:getConfig",
	GITLAB_AUTOFIX_SAVE_CONFIG: "gitlab:autofix:saveConfig",
	GITLAB_AUTOFIX_GET_BATCHES: "gitlab:autofix:getBatches",

	// GitLab Auto-Fix events (main -> renderer)
	GITLAB_AUTOFIX_PROGRESS: "gitlab:autofix:progress",
	GITLAB_AUTOFIX_COMPLETE: "gitlab:autofix:complete",
	GITLAB_AUTOFIX_ERROR: "gitlab:autofix:error",

	// GitLab Issue Analysis Preview (proactive batch workflow)
	GITLAB_AUTOFIX_ANALYZE_PREVIEW: "gitlab:autofix:analyzePreview",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_PROGRESS:
		"gitlab:autofix:analyzePreviewProgress",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE:
		"gitlab:autofix:analyzePreviewComplete",
	GITLAB_AUTOFIX_ANALYZE_PREVIEW_ERROR: "gitlab:autofix:analyzePreviewError",
	GITLAB_AUTOFIX_APPROVE_BATCHES: "gitlab:autofix:approveBatches",

	// GitLab Issue Triage operations
	GITLAB_TRIAGE_RUN: "gitlab:triage:run",
	GITLAB_TRIAGE_GET_RESULTS: "gitlab:triage:getResults",
	GITLAB_TRIAGE_APPLY_LABELS: "gitlab:triage:applyLabels",
	GITLAB_TRIAGE_GET_CONFIG: "gitlab:triage:getConfig",
	GITLAB_TRIAGE_SAVE_CONFIG: "gitlab:triage:saveConfig",

	// GitLab Issue Triage events (main -> renderer)
	GITLAB_TRIAGE_PROGRESS: "gitlab:triage:progress",
	GITLAB_TRIAGE_COMPLETE: "gitlab:triage:complete",
	GITLAB_TRIAGE_ERROR: "gitlab:triage:error",

	// GitHub Auto-Fix operations
	GITHUB_AUTOFIX_START: "github:autofix:start",
	GITHUB_AUTOFIX_GET_QUEUE: "github:autofix:getQueue",
	GITHUB_AUTOFIX_CHECK_LABELS: "github:autofix:checkLabels",
	GITHUB_AUTOFIX_CHECK_NEW: "github:autofix:checkNew",
	GITHUB_AUTOFIX_GET_CONFIG: "github:autofix:getConfig",
	GITHUB_AUTOFIX_SAVE_CONFIG: "github:autofix:saveConfig",
	GITHUB_AUTOFIX_BATCH: "github:autofix:batch",
	GITHUB_AUTOFIX_GET_BATCHES: "github:autofix:getBatches",

	// GitHub Auto-Fix events (main -> renderer)
	GITHUB_AUTOFIX_PROGRESS: "github:autofix:progress",
	GITHUB_AUTOFIX_COMPLETE: "github:autofix:complete",
	GITHUB_AUTOFIX_ERROR: "github:autofix:error",
	GITHUB_AUTOFIX_BATCH_PROGRESS: "github:autofix:batchProgress",
	GITHUB_AUTOFIX_BATCH_COMPLETE: "github:autofix:batchComplete",
	GITHUB_AUTOFIX_BATCH_ERROR: "github:autofix:batchError",

	// GitHub Issue Analysis Preview (proactive batch workflow)
	GITHUB_AUTOFIX_ANALYZE_PREVIEW: "github:autofix:analyzePreview",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_PROGRESS:
		"github:autofix:analyzePreviewProgress",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_COMPLETE:
		"github:autofix:analyzePreviewComplete",
	GITHUB_AUTOFIX_ANALYZE_PREVIEW_ERROR: "github:autofix:analyzePreviewError",
	GITHUB_AUTOFIX_APPROVE_BATCHES: "github:autofix:approveBatches",

	// GitHub PR Review operations
	GITHUB_PR_LIST: "github:pr:list",
	GITHUB_PR_LIST_MORE: "github:pr:listMore", // Load more PRs (pagination)
	GITHUB_PR_GET: "github:pr:get",
	GITHUB_PR_GET_DIFF: "github:pr:getDiff",
	GITHUB_PR_REVIEW: "github:pr:review",
	GITHUB_PR_REVIEW_CANCEL: "github:pr:reviewCancel",
	GITHUB_PR_GET_REVIEW: "github:pr:getReview",
	GITHUB_PR_GET_REVIEWS_BATCH: "github:pr:getReviewsBatch", // Batch load reviews for multiple PRs
	GITHUB_PR_POST_REVIEW: "github:pr:postReview",
	GITHUB_PR_DELETE_REVIEW: "github:pr:deleteReview",
	GITHUB_PR_MERGE: "github:pr:merge",
	GITHUB_PR_ASSIGN: "github:pr:assign",
	GITHUB_PR_POST_COMMENT: "github:pr:postComment",
	GITHUB_PR_FOLLOWUP_REVIEW: "github:pr:followupReview",
	GITHUB_PR_CHECK_NEW_COMMITS: "github:pr:checkNewCommits",
	GITHUB_PR_CHECK_MERGE_READINESS: "github:pr:checkMergeReadiness",
	GITHUB_PR_MARK_REVIEW_POSTED: "github:pr:markReviewPosted",
	GITHUB_PR_UPDATE_BRANCH: "github:pr:updateBranch",

	// GitHub PR Review events (main -> renderer)
	GITHUB_PR_REVIEW_PROGRESS: "github:pr:reviewProgress",
	GITHUB_PR_REVIEW_COMPLETE: "github:pr:reviewComplete",
	GITHUB_PR_REVIEW_ERROR: "github:pr:reviewError",

	// GitHub PR Logs (for viewing AI review logs)
	GITHUB_PR_GET_LOGS: "github:pr:getLogs",

	// Universal PR Details (supports both GitHub and Azure DevOps)
	PR_DETAILS: "pr:details",

	// GitHub PR Memory operations (saves review insights to memory layer)
	GITHUB_PR_MEMORY_GET: "github:pr:memory:get", // Get PR review memories
	GITHUB_PR_MEMORY_SEARCH: "github:pr:memory:search", // Search PR review memories

	// GitHub Workflow Approval (for fork PRs)
	GITHUB_WORKFLOWS_AWAITING_APPROVAL: "github:workflows:awaitingApproval",
	GITHUB_WORKFLOW_APPROVE: "github:workflow:approve",


	// Ollama model detection and management
	OLLAMA_CHECK_STATUS: "ollama:checkStatus",
	OLLAMA_CHECK_INSTALLED: "ollama:checkInstalled",
	OLLAMA_INSTALL: "ollama:install",
	OLLAMA_START_SERVER: "ollama:startServer",
	OLLAMA_ENSURE: "ollama:ensure",
	OLLAMA_INSTALL_PROGRESS: "ollama:installProgress",
	OLLAMA_LIST_MODELS: "ollama:listModels",
	OLLAMA_LIST_EMBEDDING_MODELS: "ollama:listEmbeddingModels",
	OLLAMA_PULL_MODEL: "ollama:pullModel",
	OLLAMA_PULL_PROGRESS: "ollama:pullProgress",
	OLLAMA_CANCEL_PULL: "ollama:cancelPull",
	OLLAMA_ACTIVE_PULLS: "ollama:activePulls",
	OLLAMA_DELETE_MODEL: "ollama:deleteModel",

	// WorkPilot AI source environment configuration
	AUTOBUILD_SOURCE_ENV_GET: "autobuild:source:env:get",
	AUTOBUILD_SOURCE_ENV_UPDATE: "autobuild:source:env:update",
	AUTOBUILD_SOURCE_ENV_CHECK_TOKEN: "autobuild:source:env:checkToken",

	// Changelog operations
	CHANGELOG_GET_DONE_TASKS: "changelog:getDoneTasks",
	CHANGELOG_LOAD_TASK_SPECS: "changelog:loadTaskSpecs",
	CHANGELOG_GENERATE: "changelog:generate",
	CHANGELOG_SAVE: "changelog:save",
	CHANGELOG_READ_EXISTING: "changelog:readExisting",
	CHANGELOG_SUGGEST_VERSION: "changelog:suggestVersion",
	CHANGELOG_SUGGEST_VERSION_FROM_COMMITS: "changelog:suggestVersionFromCommits",

	// Changelog git operations (for git-based changelog generation)
	CHANGELOG_GET_BRANCHES: "changelog:getBranches",
	CHANGELOG_GET_TAGS: "changelog:getTags",
	CHANGELOG_GET_COMMITS_PREVIEW: "changelog:getCommitsPreview",
	CHANGELOG_SAVE_IMAGE: "changelog:saveImage",
	CHANGELOG_READ_LOCAL_IMAGE: "changelog:readLocalImage",

	// Changelog events (main -> renderer)
	CHANGELOG_GENERATION_PROGRESS: "changelog:generationProgress",
	CHANGELOG_GENERATION_COMPLETE: "changelog:generationComplete",
	CHANGELOG_GENERATION_ERROR: "changelog:generationError",

	// Insights operations
	INSIGHTS_GET_SESSION: "insights:getSession",
	INSIGHTS_SEND_MESSAGE: "insights:sendMessage",
	INSIGHTS_CLEAR_SESSION: "insights:clearSession",
	INSIGHTS_CREATE_TASK: "insights:createTask",
	INSIGHTS_LIST_SESSIONS: "insights:listSessions",
	INSIGHTS_NEW_SESSION: "insights:newSession",
	INSIGHTS_SWITCH_SESSION: "insights:switchSession",
	INSIGHTS_DELETE_SESSION: "insights:deleteSession",
	INSIGHTS_RENAME_SESSION: "insights:renameSession",
	INSIGHTS_UPDATE_MODEL_CONFIG: "insights:updateModelConfig",

	// Insights events (main -> renderer)
	INSIGHTS_STREAM_CHUNK: "insights:streamChunk",
	INSIGHTS_STATUS: "insights:status",
	INSIGHTS_ERROR: "insights:error",
	INSIGHTS_SESSION_UPDATED: "insights:sessionUpdated", // Event: session updated (main -> renderer)

	// File explorer operations
	CODE_REVIEW_FILES: "codeReview:files",
	CODE_REVIEW_FILE: "codeReview:file",
	FILE_EXPLORER_LIST: "fileExplorer:list",
	FILE_EXPLORER_READ: "fileExplorer:read",
	FILE_EXPLORER_SAVE: "fileExplorer:save", // Save JSON files
	FILE_EXPLORER_SEARCH: "fileExplorer:search", // Recursive path search for autocomplete

	// API Explorer — project route scanning
	API_EXPLORER_SCAN_ROUTES: "apiExplorer:scanRoutes",
	// API Explorer — HTTP proxy (bypasses renderer CSP)
	API_EXPLORER_PROXY_REQUEST: "apiExplorer:proxyRequest",
	API_EXPLORER_PROBE_LIVE_SPEC: "apiExplorer:probeLiveSpec",
	API_EXPLORER_LOAD_SECRETS: "apiExplorer:loadSecrets",
	API_EXPLORER_SAVE_SECRETS: "apiExplorer:saveSecrets",

	// Git operations
	GIT_GET_BRANCHES: "git:getBranches",
	GIT_GET_BRANCHES_WITH_INFO: "git:getBranchesWithInfo",
	GIT_GET_CURRENT_BRANCH: "git:getCurrentBranch",
	GIT_DETECT_MAIN_BRANCH: "git:detectMainBranch",
	GIT_CHECK_STATUS: "git:checkStatus",
	GIT_DETECT_PROVIDER: "git:detectProvider",
	GIT_INITIALIZE: "git:initialize",
	GIT_SET_REMOTE: "git:setRemote",
	GIT_CHECKOUT_BRANCH: "git:checkoutBranch",

	// LLM Provider operations
	PROVIDER_SELECT: "provider:select",
	PROVIDER_GET_SELECTED: "provider:getSelected",

	// App auto-update operations
	APP_UPDATE_CHECK: "app-update:check",
	APP_UPDATE_DOWNLOAD: "app-update:download",
	APP_UPDATE_DOWNLOAD_STABLE: "app-update:download-stable", // Download stable version (for downgrade from beta)
	APP_UPDATE_INSTALL: "app-update:install",
	APP_UPDATE_GET_VERSION: "app-update:get-version",
	APP_UPDATE_GET_DOWNLOADED: "app-update:get-downloaded", // Get downloaded update info (for showing Install button on Settings open)

	// App auto-update events (main -> renderer)
	APP_UPDATE_AVAILABLE: "app-update:available",
	APP_UPDATE_DOWNLOADED: "app-update:downloaded",
	APP_UPDATE_PROGRESS: "app-update:progress",
	APP_UPDATE_ERROR: "app-update:error",
	APP_UPDATE_STABLE_DOWNGRADE: "app-update:stable-downgrade", // Stable version available for downgrade from beta
	APP_UPDATE_READONLY_VOLUME: "app-update:readonly-volume", // App running from read-only volume (DMG), needs to be moved

	// Release operations
	RELEASE_SUGGEST_VERSION: "release:suggestVersion",

	// Debug operations
	DEBUG_GET_INFO: "debug:getInfo",
	DEBUG_OPEN_LOGS_FOLDER: "debug:openLogsFolder",
	DEBUG_COPY_DEBUG_INFO: "debug:copyDebugInfo",
	DEBUG_GET_RECENT_ERRORS: "debug:getRecentErrors",
	DEBUG_LIST_LOG_FILES: "debug:listLogFiles",

	// Claude Code CLI operations
	CLAUDE_CODE_CHECK_VERSION: "claudeCode:checkVersion",
	CLAUDE_CODE_INSTALL: "claudeCode:install",
	CLAUDE_CODE_INSTALL_SILENT: "claudeCode:installSilent",
	CLAUDE_CODE_GET_VERSIONS: "claudeCode:getVersions",
	CLAUDE_CODE_INSTALL_VERSION: "claudeCode:installVersion",
	CLAUDE_CODE_GET_INSTALLATIONS: "claudeCode:getInstallations",
	CLAUDE_CODE_SET_ACTIVE_PATH: "claudeCode:setActivePath",

	// Copilot CLI operations (mirrors Claude Code CLI pattern)
	COPILOT_CLI_CHECK_VERSION: "copilotCli:checkVersion",
	COPILOT_CLI_INSTALL: "copilotCli:install",
	COPILOT_CLI_INSTALL_SILENT: "copilotCli:installSilent",
	COPILOT_CLI_GET_INSTALLATIONS: "copilotCli:getInstallations",
	COPILOT_CLI_SET_ACTIVE_PATH: "copilotCli:setActivePath",
	COPILOT_CLI_CHECK_AUTH: "copilotCli:checkAuth",
	COPILOT_CLI_START_AUTH: "copilotCli:startAuth",
	COPILOT_CLI_GET_STATUS: "copilotCli:getStatus", // Get GitHub CLI status for AuthStatusIndicator

	// Copilot OAuth operations (web-based authentication)
	COPILOT_OAUTH_START: "copilotOAuth:start",
	COPILOT_OAUTH_CALLBACK: "copilotOAuth:callback",
	COPILOT_OAUTH_STATUS: "copilotOAuth:status",
	COPILOT_OAUTH_REVOKE: "copilotOAuth:revoke",

	// MCP Server health checks
	MCP_CHECK_HEALTH: "mcp:checkHealth", // Quick connectivity check
	MCP_TEST_CONNECTION: "mcp:testConnection", // Full MCP protocol test

	// MCP Marketplace operations
	MCP_MARKETPLACE_GET_CATALOG: "mcpMarketplace:getCatalog", // Get full server catalog
	MCP_MARKETPLACE_GET_SERVER: "mcpMarketplace:getServer", // Get single server details
	MCP_MARKETPLACE_INSTALL: "mcpMarketplace:install", // Install a server
	MCP_MARKETPLACE_UNINSTALL: "mcpMarketplace:uninstall", // Uninstall a server
	MCP_MARKETPLACE_GET_INSTALLED: "mcpMarketplace:getInstalled", // Get installed servers
	MCP_MARKETPLACE_UPDATE_SERVER: "mcpMarketplace:updateServer", // Update server config
	MCP_MARKETPLACE_TOGGLE_SERVER: "mcpMarketplace:toggleServer", // Enable/disable server
	MCP_MARKETPLACE_HEALTH_CHECK: "mcpMarketplace:healthCheck", // Health check installed server
	MCP_MARKETPLACE_HEALTH_CHECK_ALL: "mcpMarketplace:healthCheckAll", // Health check all installed
	MCP_MARKETPLACE_SAVE_BUILDER: "mcpMarketplace:saveBuilder", // Save builder project
	MCP_MARKETPLACE_GET_BUILDER_PROJECTS: "mcpMarketplace:getBuilderProjects", // List builder projects
	MCP_MARKETPLACE_DELETE_BUILDER: "mcpMarketplace:deleteBuilder", // Delete builder project
	MCP_MARKETPLACE_EXPORT_BUILDER: "mcpMarketplace:exportBuilder", // Export builder as MCP server

	// Hugging Face Hub discovery (via the official HF MCP server)
	HUGGINGFACE_SEARCH_MODELS: "huggingface:searchModels", // Live model search on the Hub

	// Sentry error reporting
	SENTRY_STATE_CHANGED: "sentry:state-changed", // Notify main process when setting changes
	GET_SENTRY_DSN: "sentry:get-dsn", // Get DSN from main process (env var)
	GET_SENTRY_CONFIG: "sentry:get-config", // Get full Sentry config (DSN + sample rates)

	// Spell check
	SPELLCHECK_SET_LANGUAGES: "spellcheck:setLanguages", // Set spell check language (syncs with i18n)

	// Screenshot capture
	SCREENSHOT_GET_SOURCES: "screenshot:getSources", // Get available screens/windows
	SCREENSHOT_CAPTURE: "screenshot:capture", // Capture screenshot from source

	// Queue routing (rate limit recovery)
	QUEUE_GET_RUNNING_TASKS_BY_PROFILE: "queue:getRunningTasksByProfile",
	QUEUE_GET_BEST_PROFILE_FOR_TASK: "queue:getBestProfileForTask",
	QUEUE_ASSIGN_PROFILE_TO_TASK: "queue:assignProfileToTask",
	QUEUE_UPDATE_TASK_SESSION: "queue:updateTaskSession",
	QUEUE_GET_TASK_SESSION: "queue:getTaskSession",

	// Queue routing events (main -> renderer)
	QUEUE_PROFILE_SWAPPED: "queue:profileSwapped", // Task switched to different profile
	QUEUE_SESSION_CAPTURED: "queue:sessionCaptured", // Session ID captured from running task
	QUEUE_BLOCKED_NO_PROFILES: "queue:blockedNoProfiles", // All profiles unavailable

	// Prompt Optimizer operations
	PROMPT_OPTIMIZER_OPTIMIZE: "promptOptimizer:optimize", // Request prompt optimization
	PROMPT_OPTIMIZER_CANCEL: "promptOptimizer:cancel", // Cancel the running optimization
	PROMPT_OPTIMIZER_STREAM_CHUNK: "promptOptimizer:streamChunk", // Streaming text chunk (main -> renderer)
	PROMPT_OPTIMIZER_STATUS: "promptOptimizer:status", // Status update (main -> renderer)
	PROMPT_OPTIMIZER_ERROR: "promptOptimizer:error", // Error event (main -> renderer)
	PROMPT_OPTIMIZER_COMPLETE: "promptOptimizer:complete", // Optimization complete (main -> renderer)

	// Context-Aware Snippets operations
	CONTEXT_AWARE_SNIPPETS_GENERATE: "context-aware-snippets:generate", // Start a generation (invoke: started, or why not)
	CONTEXT_AWARE_SNIPPETS_CANCEL: "context-aware-snippets:cancel", // Cancel the running generation
	CONTEXT_AWARE_SNIPPETS_STREAM_CHUNK: "context-aware-snippets:stream-chunk", // Streaming model text (main -> renderer)
	CONTEXT_AWARE_SNIPPETS_STATUS: "context-aware-snippets:status", // Status code (main -> renderer)
	CONTEXT_AWARE_SNIPPETS_ERROR: "context-aware-snippets:error", // Coded error (main -> renderer)
	CONTEXT_AWARE_SNIPPETS_COMPLETE: "context-aware-snippets:complete", // Structured result (main -> renderer)

	// Learning Loop operations
	LEARNING_LOOP_GET_PATTERNS: "learningLoop:getPatterns",
	LEARNING_LOOP_GET_SUMMARY: "learningLoop:getSummary",
	LEARNING_LOOP_RUN_ANALYSIS: "learningLoop:runAnalysis",
	LEARNING_LOOP_STOP_ANALYSIS: "learningLoop:stopAnalysis",
	LEARNING_LOOP_DELETE_PATTERN: "learningLoop:deletePattern",
	LEARNING_LOOP_TOGGLE_PATTERN: "learningLoop:togglePattern",
	LEARNING_LOOP_GET_LESSONS: "learningLoop:getLessons",
	LEARNING_LOOP_ADOPT_LESSON: "learningLoop:adoptLesson",
	LEARNING_LOOP_DISMISS_LESSON: "learningLoop:dismissLesson",

	// Learning Loop events (main -> renderer)
	LEARNING_LOOP_STATUS: "learningLoop:status",
	LEARNING_LOOP_STREAM_CHUNK: "learningLoop:streamChunk",
	LEARNING_LOOP_COMPLETE: "learningLoop:complete",
	LEARNING_LOOP_ERROR: "learningLoop:error",

	// Multi-Repo Orchestration operations
	MULTI_REPO_CREATE: "multiRepo:create",
	MULTI_REPO_GET: "multiRepo:get",
	MULTI_REPO_LIST: "multiRepo:list",
	MULTI_REPO_START: "multiRepo:start",
	MULTI_REPO_STOP: "multiRepo:stop",
	MULTI_REPO_GET_STATUS: "multiRepo:getStatus",

	// Multi-Repo events (main -> renderer)
	MULTI_REPO_PROGRESS: "multiRepo:progress",
	MULTI_REPO_REPO_START: "multiRepo:repoStart",
	MULTI_REPO_REPO_COMPLETE: "multiRepo:repoComplete",
	MULTI_REPO_COMPLETE: "multiRepo:complete",
	MULTI_REPO_ERROR: "multiRepo:error",
	MULTI_REPO_BREAKING_CHANGE: "multiRepo:breakingChange",
	MULTI_REPO_GRAPH: "multiRepo:graph",

	// Self-Healing Codebase + Incident Responder
	SELF_HEALING_GET_DASHBOARD: "selfHealing:getDashboard",
	SELF_HEALING_GET_INCIDENTS: "selfHealing:getIncidents",
	SELF_HEALING_GET_OPERATIONS: "selfHealing:getOperations",
	SELF_HEALING_GET_FRAGILITY: "selfHealing:getFragility",
	SELF_HEALING_CICD_ENABLE: "selfHealing:cicd:enable",
	SELF_HEALING_CICD_DISABLE: "selfHealing:cicd:disable",
	SELF_HEALING_CICD_CONFIG: "selfHealing:cicd:config",
	SELF_HEALING_PRODUCTION_CONNECT: "selfHealing:production:connect",
	SELF_HEALING_PRODUCTION_DISCONNECT: "selfHealing:production:disconnect",
	SELF_HEALING_PRODUCTION_CONFIG: "selfHealing:production:config",
	SELF_HEALING_PROACTIVE_SCAN: "selfHealing:proactive:scan",
	SELF_HEALING_PROACTIVE_CONFIG: "selfHealing:proactive:config",
	SELF_HEALING_TRIGGER_FIX: "selfHealing:triggerFix",
	SELF_HEALING_CANCEL_OPERATION: "selfHealing:cancelOperation",
	SELF_HEALING_DISMISS_INCIDENT: "selfHealing:dismissIncident",
	SELF_HEALING_RETRY_INCIDENT: "selfHealing:retryIncident",
	// Events (main -> renderer)
	SELF_HEALING_OPERATION_PROGRESS: "selfHealing:operationProgress",
	SELF_HEALING_OPERATION_COMPLETE: "selfHealing:operationComplete",

	// Browser Agent
	BROWSER_AGENT_GET_DASHBOARD: "browserAgent:getDashboard",
	BROWSER_AGENT_NAVIGATE: "browserAgent:navigate",
	BROWSER_AGENT_CAPTURE_SCREENSHOT: "browserAgent:captureScreenshot",
	BROWSER_AGENT_GET_SCREENSHOT_IMAGE: "browserAgent:getScreenshotImage",
	BROWSER_AGENT_SET_BASELINE: "browserAgent:setBaseline",
	BROWSER_AGENT_LIST_BASELINES: "browserAgent:listBaselines",
	BROWSER_AGENT_COMPARE: "browserAgent:compare",
	BROWSER_AGENT_DELETE_BASELINE: "browserAgent:deleteBaseline",
	BROWSER_AGENT_RUN_TESTS: "browserAgent:runTests",

	// Architecture Visualizer
	ARCHITECTURE_VISUALIZER_GENERATE: "architectureVisualizer:generate",
	ARCHITECTURE_VISUALIZER_CANCEL: "architectureVisualizer:cancel",
	ARCHITECTURE_VISUALIZER_DOCTOR: "architectureVisualizer:doctor",
	// Per-task architecture delta
	ARCHITECTURE_DELTA_READ: "architectureVisualizer:delta",
	ARCHITECTURE_DELTA_REGENERATE: "architectureVisualizer:regenerateDelta",
	ARCHITECTURE_ARTIFACT_READ: "architectureVisualizer:readArtifact",
	// Architecture Visualizer events (main -> renderer)
	ARCHITECTURE_VISUALIZER_STATUS: "architectureVisualizer:status",
	ARCHITECTURE_VISUALIZER_STREAM_CHUNK: "architectureVisualizer:streamChunk",
	ARCHITECTURE_VISUALIZER_ERROR: "architectureVisualizer:error",
	ARCHITECTURE_VISUALIZER_COMPLETE: "architectureVisualizer:complete",
	ARCHITECTURE_DELTA_STATUS: "architectureVisualizer:deltaStatus",

	// Code Migration Agent
	CODE_MIGRATION_START: "codeMigration:start",
	CODE_MIGRATION_CANCEL: "codeMigration:cancel",
	// Code Migration events (main -> renderer)
	CODE_MIGRATION_STATUS: "codeMigration:status",
	CODE_MIGRATION_STREAM_CHUNK: "codeMigration:streamChunk",
	CODE_MIGRATION_ERROR: "codeMigration:error",
	CODE_MIGRATION_COMPLETE: "codeMigration:complete",
	CODE_MIGRATION_TASK_PROGRESS: "codeMigration:taskProgress",

	// Performance Profiler Agent
	PERFORMANCE_PROFILER_START: "performanceProfiler:start",
	PERFORMANCE_PROFILER_CANCEL: "performanceProfiler:cancel",
	// Performance Profiler events (main -> renderer)
	PERFORMANCE_PROFILER_STATUS: "performanceProfiler:status",
	PERFORMANCE_PROFILER_STREAM_CHUNK: "performanceProfiler:streamChunk",
	PERFORMANCE_PROFILER_ERROR: "performanceProfiler:error",
	PERFORMANCE_PROFILER_COMPLETE: "performanceProfiler:complete",
	PERFORMANCE_PROFILER_IMPLEMENTATION_COMPLETE:
		"performanceProfiler:implementationComplete",

	// Documentation Agent
	DOCUMENTATION_AGENT_GENERATE: "documentationAgent:generate",
	DOCUMENTATION_AGENT_CANCEL: "documentationAgent:cancel",
	// Documentation Agent events (main -> renderer)
	DOCUMENTATION_AGENT_STATUS: "documentationAgent:status",
	DOCUMENTATION_AGENT_STREAM_CHUNK: "documentationAgent:streamChunk",
	DOCUMENTATION_AGENT_ERROR: "documentationAgent:error",
	DOCUMENTATION_AGENT_COMPLETE: "documentationAgent:complete",

	// Pipeline Generator (Feature 23) — AI-powered CI/CD pipeline generation
	PIPELINE_GENERATOR_GENERATE: "pipelineGenerator:generate",
	PIPELINE_GENERATOR_CANCEL: "pipelineGenerator:cancel",
	// Pipeline Generator events (main -> renderer)
	PIPELINE_GENERATOR_STATUS: "pipelineGenerator:status",
	PIPELINE_GENERATOR_STREAM_CHUNK: "pipelineGenerator:streamChunk",
	PIPELINE_GENERATOR_ERROR: "pipelineGenerator:error",
	PIPELINE_GENERATOR_COMPLETE: "pipelineGenerator:complete",

	// AI Pair Programming (Feature 10) — Real parallel coordinated work
	PAIR_PROGRAMMING_START: "pairProgramming:start",
	PAIR_PROGRAMMING_STOP: "pairProgramming:stop",
	PAIR_PROGRAMMING_SEND_MESSAGE: "pairProgramming:sendMessage",
	PAIR_PROGRAMMING_GET_SESSION: "pairProgramming:getSession",
	// Pair Programming events (main -> renderer)
	PAIR_PROGRAMMING_STREAM_CHUNK: "pairProgramming:streamChunk",
	PAIR_PROGRAMMING_STATUS: "pairProgramming:status",
	PAIR_PROGRAMMING_AI_ACTION: "pairProgramming:aiAction",
	PAIR_PROGRAMMING_CONFLICT: "pairProgramming:conflict",
	PAIR_PROGRAMMING_ERROR: "pairProgramming:error",
	PAIR_PROGRAMMING_COMPLETE: "pairProgramming:complete",

	// Context Mesh — Cross-Project Intelligence
	CONTEXT_MESH_GET_PROJECTS: "contextMesh:getProjects",
	CONTEXT_MESH_REGISTER_PROJECT: "contextMesh:registerProject",
	CONTEXT_MESH_UNREGISTER_PROJECT: "contextMesh:unregisterProject",
	CONTEXT_MESH_GET_PATTERNS: "contextMesh:getPatterns",
	CONTEXT_MESH_DELETE_PATTERN: "contextMesh:deletePattern",
	CONTEXT_MESH_GET_HANDBOOK: "contextMesh:getHandbook",
	CONTEXT_MESH_DELETE_HANDBOOK_ENTRY: "contextMesh:deleteHandbookEntry",
	CONTEXT_MESH_GET_SKILL_TRANSFERS: "contextMesh:getSkillTransfers",
	CONTEXT_MESH_UPDATE_TRANSFER_STATUS: "contextMesh:updateTransferStatus",
	CONTEXT_MESH_GET_RECOMMENDATIONS: "contextMesh:getRecommendations",
	CONTEXT_MESH_UPDATE_RECOMMENDATION_STATUS:
		"contextMesh:updateRecommendationStatus",
	CONTEXT_MESH_GET_SUMMARY: "contextMesh:getSummary",
	CONTEXT_MESH_RUN_ANALYSIS: "contextMesh:runAnalysis",
	CONTEXT_MESH_STOP_ANALYSIS: "contextMesh:stopAnalysis",
	// Context Mesh events (main -> renderer)
	CONTEXT_MESH_STATUS: "contextMesh:status",
	CONTEXT_MESH_STREAM_CHUNK: "contextMesh:streamChunk",
	CONTEXT_MESH_COMPLETE: "contextMesh:complete",
	CONTEXT_MESH_ERROR: "contextMesh:error",

	// Live Development Companion — Real-time pair programming
	LIVE_COMPANION_START: "liveCompanion:start",
	LIVE_COMPANION_STOP: "liveCompanion:stop",
	LIVE_COMPANION_GET_STATE: "liveCompanion:getState",
	LIVE_COMPANION_GET_SUGGESTIONS: "liveCompanion:getSuggestions",
	LIVE_COMPANION_DISMISS_SUGGESTION: "liveCompanion:dismissSuggestion",
	LIVE_COMPANION_APPLY_SUGGESTION: "liveCompanion:applySuggestion",
	LIVE_COMPANION_GET_TAKEOVERS: "liveCompanion:getTakeovers",
	LIVE_COMPANION_ACCEPT_TAKEOVER: "liveCompanion:acceptTakeover",
	LIVE_COMPANION_DECLINE_TAKEOVER: "liveCompanion:declineTakeover",
	LIVE_COMPANION_GET_CONFIG: "liveCompanion:getConfig",
	LIVE_COMPANION_UPDATE_CONFIG: "liveCompanion:updateConfig",
	// Live Companion events (main -> renderer)
	LIVE_COMPANION_STATE_CHANGED: "liveCompanion:stateChanged",
	LIVE_COMPANION_SUGGESTION: "liveCompanion:suggestion",
	LIVE_COMPANION_TAKEOVER_PROPOSAL: "liveCompanion:takeoverProposal",
	LIVE_COMPANION_FILE_CHANGE: "liveCompanion:fileChange",

	// Agent Time Travel — Temporal debugger for AI agents
	TIME_TRAVEL_GENERATE_CHECKPOINTS: "timeTravel:generateCheckpoints",
	TIME_TRAVEL_GET_CHECKPOINTS: "timeTravel:getCheckpoints",
	TIME_TRAVEL_GET_CHECKPOINT: "timeTravel:getCheckpoint",
	TIME_TRAVEL_ADD_CHECKPOINT: "timeTravel:addCheckpoint",
	TIME_TRAVEL_DELETE_CHECKPOINT: "timeTravel:deleteCheckpoint",
	TIME_TRAVEL_FORK_SESSION: "timeTravel:forkSession",
	TIME_TRAVEL_GET_FORK: "timeTravel:getFork",
	TIME_TRAVEL_GET_FORK_CONTEXT: "timeTravel:getForkContext",
	TIME_TRAVEL_LIST_FORKS: "timeTravel:listForks",
	TIME_TRAVEL_UPDATE_FORK_STATUS: "timeTravel:updateForkStatus",
	TIME_TRAVEL_DELETE_FORK: "timeTravel:deleteFork",
	TIME_TRAVEL_SCORE_DECISIONS: "timeTravel:scoreDecisions",
	TIME_TRAVEL_GET_DECISION_SCORES: "timeTravel:getDecisionScores",
	TIME_TRAVEL_GET_DECISION_HEATMAP: "timeTravel:getDecisionHeatmap",

	// === Phase 3-5 backend modules (one HTTP-backed channel per module) ===
	// Longevity Score (#3.8)
	LONGEVITY_SCORE: "longevity:score",
	// Agent Health Monitor (#3.11)
	AGENT_HEALTH_RECORD: "agentHealth:record",
	AGENT_HEALTH_RECORD_BATCH: "agentHealth:recordBatch",
	AGENT_HEALTH_SCORE: "agentHealth:score",
	AGENT_HEALTH_SCORES: "agentHealth:scores",
	AGENT_HEALTH_RESET: "agentHealth:reset",
	// Adaptive Model Routing (#3.1)
	MODEL_ROUTER_ROUTE: "modelRouter:route",
	MODEL_ROUTER_COMPARE: "modelRouter:compare",
	// Domain-Specific Agents (#3.6)
	DOMAIN_AGENTS_LIST: "domainAgents:list",
	DOMAIN_AGENTS_PROFILE: "domainAgents:profile",
	DOMAIN_AGENTS_BUILD: "domainAgents:build",
	// CI/CD Anomaly Detective (#3.4)
	CICD_ANOMALY_SCAN: "cicdAnomaly:scan",
	CICD_ANOMALY_ANALYSE: "cicdAnomaly:analyse",
	// License Governance (#3.7)
	LICENSE_GOV_SCAN: "licenseGov:scan",
	LICENSE_GOV_CLASSIFY: "licenseGov:classify",
	// Architecture Drift (#3.9)
	ARCH_DRIFT_SCAN: "archDrift:scan",
	ARCH_DRIFT_SAVE_BASELINE: "archDrift:saveBaseline",
	ARCH_DRIFT_COMPARE: "archDrift:compare",
	// Generational Testing (#3.10)
	GEN_TESTS_LIST: "genTests:list",
	GEN_TESTS_CAPTURE: "genTests:capture",
	GEN_TESTS_COMPARE: "genTests:compare",
	GEN_TESTS_DELETE: "genTests:delete",
	// i18n Auto-Scaling (#3.12)
	I18N_SCALER_DIFF: "i18nScaler:diff",
	I18N_SCALER_SKELETON: "i18nScaler:skeleton",
	I18N_SCALER_REPORT_FROM_DIR: "i18nScaler:reportFromDir",
	I18N_EDITOR_DETECT: "i18nEditor:detect",
	I18N_EDITOR_NAMESPACES: "i18nEditor:namespaces",
	I18N_EDITOR_NAMESPACE: "i18nEditor:namespace",
	I18N_EDITOR_MUTATE: "i18nEditor:mutate",
	// Cognitive Context Optimizer (#3.2)
	COGNITIVE_CONTEXT_OPTIMIZE: "cognitiveContext:optimize",
	// Audit Trail (#3.3)
	AUDIT_TRAIL_APPEND: "auditTrail:append",
	AUDIT_TRAIL_APPEND_DECISION: "auditTrail:appendDecision",
	AUDIT_TRAIL_EVENTS: "auditTrail:events",
	AUDIT_TRAIL_REPLAY: "auditTrail:replay",
	AUDIT_TRAIL_VERIFY: "auditTrail:verify",
	AUDIT_TRAIL_LIST: "auditTrail:list",
	// Pair Programming Realtime (#3.5)
	PAIR_RT_CREATE_ROOM: "pairRT:createRoom",
	PAIR_RT_LIST_ROOMS: "pairRT:listRooms",
	PAIR_RT_GET_ROOM: "pairRT:getRoom",
	PAIR_RT_CLOSE_ROOM: "pairRT:closeRoom",
	PAIR_RT_JOIN: "pairRT:join",
	PAIR_RT_LEAVE: "pairRT:leave",
	PAIR_RT_EDIT: "pairRT:edit",
	PAIR_RT_CURSOR: "pairRT:cursor",
	PAIR_RT_CHAT: "pairRT:chat",
	PAIR_RT_SUGGESTION: "pairRT:suggestion",
	PAIR_RT_OPS: "pairRT:ops",
	PAIR_RT_SUBSCRIBE: "pairRT:subscribe",
	PAIR_RT_UNSUBSCRIBE: "pairRT:unsubscribe",
	// Pair Programming SSE event (main -> renderer)
	PAIR_RT_OP_EVENT: "pairRT:opEvent",
	PAIR_RT_STREAM_ERROR: "pairRT:streamError",

	// Mobile applications (Android / Apple). Distinct from the App Emulator's
	// channels rather than folded into them: the two answer different questions
	// ("what URL" vs "which device"), and a `start` meaning one thing for a web
	// project and another for a phone one is a channel nobody can reason about.
	MOBILE_DETECT: "mobile:detect",
	MOBILE_DEVICES: "mobile:devices",
	MOBILE_LAUNCH: "mobile:launch",
	MOBILE_SCREENSHOT: "mobile:screenshot",
	MOBILE_STOP: "mobile:stop",
	MOBILE_STATUS: "mobile:status",
	// Mobile events (main -> renderer)
	MOBILE_PLAN_EVENT: "mobile:plan",
	MOBILE_PHASE_EVENT: "mobile:phase",
	MOBILE_STATUS_EVENT: "mobile:status-update",
	MOBILE_OUTPUT_EVENT: "mobile:output",
	MOBILE_SCREENSHOT_EVENT: "mobile:screenshot-update",
	MOBILE_ERROR_EVENT: "mobile:error",
	MOBILE_STOPPED_EVENT: "mobile:stopped",

	// Channels that main and preload named by their string until lot M7,
	// sorted by name
	ACCESSIBILITY_CANCEL: "accessibility:cancel",
	ACCESSIBILITY_ERROR: "accessibility-error",
	ACCESSIBILITY_EVENT: "accessibility-event",
	ACCESSIBILITY_RESULT: "accessibility-result",
	ACCESSIBILITY_RUN: "accessibility:run",
	AGENT_CLI_CHECK: "agentCli:check",
	AGENT_CLI_PROBE_ACP: "agentCli:probeAcp",
	AGENT_CLI_INSTALL: "agentCli:install",
	AGENT_COACH_CANCEL: "agentCoach:cancel",
	AGENT_COACH_ERROR: "agent-coach-error",
	AGENT_COACH_EVENT: "agent-coach-event",
	AGENT_COACH_RESULT: "agent-coach-result",
	AGENT_COACH_RUN: "agentCoach:run",
	AGENT_DEBUGGER_ATTACH: "agentDebugger:attach",
	AGENT_DEBUGGER_DETACH: "agentDebugger:detach",
	AGENT_DEBUGGER_GET_STATE: "agentDebugger:getState",
	AGENT_DEBUGGER_LIST_BREAKPOINTS: "agentDebugger:listBreakpoints",
	AGENT_DEBUGGER_LIST_FRAMES: "agentDebugger:listFrames",
	AGENT_DEBUGGER_LIST_SESSIONS: "agentDebugger:listSessions",
	AGENT_DEBUGGER_REMOVE_BREAKPOINT: "agentDebugger:removeBreakpoint",
	AGENT_DEBUGGER_RESUME: "agentDebugger:resume",
	AGENT_DEBUGGER_SET_BREAKPOINT: "agentDebugger:setBreakpoint",
	// The last report a member saved of an analysis of a server project
	ANALYSIS_SHARED_REPORT: "analyses:sharedReport",
	API_WATCHER_CANCEL: "apiWatcher:cancel",
	API_WATCHER_ERROR: "api-watcher-error",
	API_WATCHER_EVENT: "api-watcher-event",
	API_WATCHER_RESULT: "api-watcher-result",
	API_WATCHER_RUN: "apiWatcher:run",
	APP_EMULATOR_CONFIG: "app-emulator:config",
	APP_EMULATOR_DETECT: "app-emulator:detect",
	APP_EMULATOR_ERROR: "app-emulator:error",
	APP_EMULATOR_OUTPUT: "app-emulator:output",
	APP_EMULATOR_READY: "app-emulator:ready",
	APP_EMULATOR_START: "app-emulator:start",
	APP_EMULATOR_STATUS: "app-emulator:status",
	APP_EMULATOR_STATUS_UPDATE: "app-emulator:status-update",
	APP_EMULATOR_STOP: "app-emulator:stop",
	APP_EMULATOR_STOPPED: "app-emulator:stopped",
	ARENA_BATTLE_COMPLETE: "arena:battleComplete",
	ARENA_BATTLE_ERROR: "arena:battleError",
	ARENA_BATTLE_PROGRESS: "arena:battleProgress",
	ARENA_BATTLE_RESULT: "arena:battleResult",
	ARENA_CLEAR_HISTORY: "arena:clearHistory",
	ARENA_GET_ANALYTICS: "arena:getAnalytics",
	ARENA_GET_BATTLES: "arena:getBattles",
	ARENA_START_BATTLE: "arena:startBattle",
	ARENA_VOTE: "arena:vote",
	AUTO_REFACTOR_CANCEL: "auto-refactor:cancel",
	AUTO_REFACTOR_COMPLETE: "auto-refactor:complete",
	AUTO_REFACTOR_ERROR: "auto-refactor:error",
	AUTO_REFACTOR_EXECUTION_COMPLETE: "auto-refactor:execution-complete",
	AUTO_REFACTOR_START: "auto-refactor:start",
	AUTO_REFACTOR_STATUS: "auto-refactor:status",
	AUTO_REFACTOR_STREAM_CHUNK: "auto-refactor:stream-chunk",
	AUTOMATIONS_DELETE: "automations:delete",
	AUTOMATIONS_EVENT: "automations:event",
	AUTOMATIONS_GET: "automations:get",
	AUTOMATIONS_RUN: "automations:run",
	AUTOMATIONS_SAVE: "automations:save",
	BENCH_CANDIDATES: "bench:candidates",
	BENCH_DISCARD: "bench:discard",
	BENCH_EVENT: "bench:event",
	BENCH_START: "bench:start",
	BENCH_STATUS: "bench:status",
	BLAST_RADIUS_ANALYZE: "blastRadius:analyze",
	BOUNTY_BOARD_LIST_ARCHIVES: "bountyBoard:listArchives",
	BOUNTY_BOARD_START: "bountyBoard:start",
	CANCEL_CONFLICT_PREDICTION: "cancel-conflict-prediction",
	CANCEL_NATURAL_LANGUAGE_GIT: "cancel-natural-language-git",
	CANCEL_SMART_ESTIMATION: "cancel-smart-estimation",
	CARBON_PROFILER_CANCEL: "carbonProfiler:cancel",
	CARBON_PROFILER_ERROR: "carbon-profiler-error",
	CARBON_PROFILER_EVENT: "carbon-profiler-event",
	CARBON_PROFILER_RESULT: "carbon-profiler-result",
	CARBON_PROFILER_RUN: "carbonProfiler:run",
	CICD_TRIGGERS_CANCEL_RUN: "cicdTriggers:cancelRun",
	CICD_TRIGGERS_GET_CONFIG: "cicdTriggers:getConfig",
	CICD_TRIGGERS_GET_RUN_STATUS: "cicdTriggers:getRunStatus",
	CICD_TRIGGERS_LIST_RUNS: "cicdTriggers:listRuns",
	CICD_TRIGGERS_SET_CONFIG: "cicdTriggers:setConfig",
	CICD_TRIGGERS_TRIGGER: "cicdTriggers:trigger",
	CLAUDE_PROFILE_CREATE_DIR: "claude:profileCreateDir",
	CODE_PLAYGROUND_CANCEL: "code-playground:cancel",
	CODE_PLAYGROUND_COMPLETE: "code-playground:complete",
	CODE_PLAYGROUND_ERROR: "code-playground:error",
	CODE_PLAYGROUND_START: "code-playground:start",
	CODE_PLAYGROUND_STATUS: "code-playground:status",
	CODE_PLAYGROUND_STREAM_CHUNK: "code-playground:stream-chunk",
	COMPLIANCE_CANCEL: "compliance:cancel",
	COMPLIANCE_ERROR: "compliance-error",
	COMPLIANCE_EVENT: "compliance-event",
	COMPLIANCE_RESULT: "compliance-result",
	COMPLIANCE_RUN: "compliance:run",
	CONFLICT_PREDICTOR_COMPLETE: "conflict-predictor-complete",
	CONFLICT_PREDICTOR_ERROR: "conflict-predictor-error",
	CONFLICT_PREDICTOR_EVENT: "conflict-predictor-event",
	CONSENSUS_ARBITER_CANCEL: "consensusArbiter:cancel",
	CONSENSUS_ARBITER_ERROR: "consensus-arbiter-error",
	CONSENSUS_ARBITER_EVENT: "consensus-arbiter-event",
	CONSENSUS_ARBITER_RESULT: "consensus-arbiter-result",
	CONSENSUS_ARBITER_RUN: "consensusArbiter:run",
	COSTS_GET_BUDGET: "costs:getBudget",
	COSTS_GET_CONTEXT_USAGE: "costs:getContextUsage",
	COSTS_GET_SUMMARY: "costs:getSummary",
	COSTS_SET_BUDGET: "costs:setBudget",
	COST_PREDICTOR_RUN: "costPredictor:run",
	CREDENTIAL_CHECK_CLAUDE_OAUTH: "credential:checkClaudeOAuth",
	CREDENTIAL_CHECK_OPENAI_CODEX_OAUTH: "credential:checkOpenAICodexOAuth",
	CREDENTIAL_DETECT_WINDSURF_TOKEN: "credential:detectWindsurfToken",
	CREDENTIAL_GET_ACTIVE: "credential:getActive",
	CREDENTIAL_SET_ACTIVE: "credential:setActive",
	CREDENTIAL_TEST_PROVIDER: "credential:testProvider",
	CREDENTIAL_UPDATE_CODEX_CLI: "credential:updateCodexCli",
	CREDENTIAL_VALIDATE: "credential:validate",
	CROSS_LANG_TRANSLATION_CANCEL: "crossLangTranslation:cancel",
	CROSS_LANG_TRANSLATION_CLEAR_HISTORY: "crossLangTranslation:clearHistory",
	CROSS_LANG_TRANSLATION_GET_HISTORY: "crossLangTranslation:getHistory",
	CROSS_LANG_TRANSLATION_GET_SUPPORTED_LANGUAGES: "crossLangTranslation:getSupportedLanguages",
	CROSS_LANG_TRANSLATION_STREAM_CHUNK: "crossLangTranslation:streamChunk",
	CROSS_LANG_TRANSLATION_TRANSLATE: "crossLangTranslation:translate",
	DASHBOARD_GET_SNAPSHOT: "dashboard:getSnapshot",
	DESIGN_TO_CODE_RUN: "designToCode:run",
	DOC_DRIFT_CANCEL: "docDrift:cancel",
	DOC_DRIFT_ERROR: "doc-drift-error",
	DOC_DRIFT_EVENT: "doc-drift-event",
	DOC_DRIFT_RESULT: "doc-drift-result",
	DOC_DRIFT_RUN: "docDrift:run",
	ENV_SNAPSHOT_CAPTURE: "envSnapshot:capture",
	ENV_SNAPSHOT_EXPORT: "envSnapshot:export",
	ENV_SNAPSHOT_GET: "envSnapshot:get",
	ENV_SNAPSHOT_LIST: "envSnapshot:list",
	ENV_SNAPSHOT_REPLAY: "envSnapshot:replay",
	EXECUTE_NATURAL_LANGUAGE_GIT: "execute-natural-language-git",
	FLAKY_TESTS_CANCEL: "flakyTests:cancel",
	FLAKY_TESTS_ERROR: "flaky-tests-error",
	FLAKY_TESTS_EVENT: "flaky-tests-event",
	FLAKY_TESTS_RESULT: "flaky-tests-result",
	FLAKY_TESTS_RUN: "flakyTests:run",
	FORMULA_MATRIX_REFINE: "formulaMatrix:refine",
	FORMULA_MATRIX_RUN: "formulaMatrix:run",
	GITHUB_COPILOT_AUTHENTICATE: "github-copilot:authenticate",
	GITHUB_COPILOT_GET_CONFIG: "github-copilot:getConfig",
	GITHUB_COPILOT_GET_ENV: "github-copilot:getEnv",
	GITHUB_COPILOT_GET_STATUS: "github-copilot:getStatus",
	GITHUB_COPILOT_LOGOUT: "github-copilot:logout",
	GITHUB_COPILOT_REFRESH_STATUS: "github-copilot:refreshStatus",
	GITHUB_COPILOT_REMOVE_TOKEN: "github-copilot:removeToken",
	GITHUB_COPILOT_SET_TOKEN: "github-copilot:setToken",
	GITHUB_COPILOT_TEST_CONNECTION: "github-copilot:testConnection",
	GITHUB_TEST_CONNECTION: "github:testConnection",
	GIT_SURGEON_CANCEL: "gitSurgeon:cancel",
	GIT_SURGEON_ERROR: "git-surgeon-error",
	GIT_SURGEON_EVENT: "git-surgeon-event",
	GIT_SURGEON_RESULT: "git-surgeon-result",
	GIT_SURGEON_RUN: "gitSurgeon:run",
	GUARDRAILS_LOAD: "guardrails:load",
	GUARDRAILS_SAVE: "guardrails:save",
	GUARDRAILS_TEST: "guardrails:test",
	I18N_AGENT_CANCEL: "i18nAgent:cancel",
	I18N_AGENT_ERROR: "i18n-agent-error",
	I18N_AGENT_EVENT: "i18n-agent-event",
	I18N_AGENT_RESULT: "i18n-agent-result",
	I18N_AGENT_RUN: "i18nAgent:run",
	INJECTION_GUARD_CANCEL: "injectionGuard:cancel",
	INJECTION_GUARD_ERROR: "injection-guard-error",
	INJECTION_GUARD_EVENT: "injection-guard-event",
	INJECTION_GUARD_RESULT: "injection-guard-result",
	INJECTION_GUARD_RUN: "injectionGuard:run",
	NATURAL_LANGUAGE_GIT_COMPLETE: "natural-language-git-complete",
	NATURAL_LANGUAGE_GIT_ERROR: "natural-language-git-error",
	NATURAL_LANGUAGE_GIT_STATUS: "natural-language-git-status",
	NATURAL_LANGUAGE_GIT_STREAM_CHUNK: "natural-language-git-stream-chunk",
	NOTEBOOK_AGENT_CANCEL: "notebookAgent:cancel",
	NOTEBOOK_AGENT_RUN: "notebookAgent:run",
	NOTEBOOK_ERROR: "notebook-error",
	NOTEBOOK_EVENT: "notebook-event",
	NOTEBOOK_RESULT: "notebook-result",
	OFFLINE_MODE_GET_POLICY: "offlineMode:getPolicy",
	OFFLINE_MODE_LIST_MODELS: "offlineMode:listModels",
	OFFLINE_MODE_REPORT: "offlineMode:report",
	OFFLINE_MODE_SCAN_MODELS: "offlineMode:scanModels",
	OFFLINE_MODE_SET_POLICY: "offlineMode:setPolicy",
	OFFLINE_MODE_STATUS: "offlineMode:status",
	ONBOARDING_AGENT_CANCEL: "onboardingAgent:cancel",
	ONBOARDING_AGENT_RUN: "onboardingAgent:run",
	ONBOARDING_ERROR: "onboarding-error",
	ONBOARDING_EVENT: "onboarding-event",
	ONBOARDING_RESULT: "onboarding-result",
	PLUGIN_MARKETPLACE_CREATE: "pluginMarketplace:create",
	PLUGIN_MARKETPLACE_GET_CATALOG: "pluginMarketplace:getCatalog",
	PLUGIN_MARKETPLACE_GET_INSTALLED: "pluginMarketplace:getInstalled",
	PLUGIN_MARKETPLACE_INSTALL: "pluginMarketplace:install",
	PLUGIN_MARKETPLACE_OPEN_LOCAL_FOLDER: "pluginMarketplace:openLocalFolder",
	PLUGIN_MARKETPLACE_TOGGLE: "pluginMarketplace:toggle",
	PLUGIN_MARKETPLACE_UNINSTALL: "pluginMarketplace:uninstall",
	PROJECT_HAS_LOCAL_SOURCE: "project:has-local-source",
	PROVIDERS_GET_CONFIGURED_PROVIDERS: "providers:getConfiguredProviders",
	PYTHON_ENV_GET_STATUS: "python-env:get-status",
	PYTHON_ENV_REINITIALIZE: "python-env:reinitialize",
	QUALITY_ANALYZE: "quality:analyze",
	QUALITY_ANALYZE_PR: "quality:analyze-pr",
	REGRESSION_GUARDIAN_CANCEL: "regressionGuardian:cancel",
	REGRESSION_GUARDIAN_ERROR: "regression-guardian-error",
	REGRESSION_GUARDIAN_EVENT: "regression-guardian-event",
	REGRESSION_GUARDIAN_RESULT: "regression-guardian-result",
	REGRESSION_GUARDIAN_RUN: "regressionGuardian:run",
	RELEASE_COORDINATOR_CANCEL: "releaseCoordinator:cancel",
	RELEASE_COORDINATOR_ERROR: "release-coordinator-error",
	RELEASE_COORDINATOR_EVENT: "release-coordinator-event",
	RELEASE_COORDINATOR_RESULT: "release-coordinator-result",
	RELEASE_COORDINATOR_RUN: "releaseCoordinator:run",
	RUN_CONFLICT_PREDICTION: "run-conflict-prediction",
	RUN_SMART_ESTIMATION: "run-smart-estimation",
	SANDBOX_CANCEL: "sandbox:cancel",
	SANDBOX_ERROR: "sandbox-error",
	SANDBOX_EVENT: "sandbox-event",
	SANDBOX_RESULT: "sandbox-result",
	SANDBOX_RUN: "sandbox:run",
	SERVER_ADMIN_ACTIVATE_USER: "server-admin:activate-user",
	SERVER_ADMIN_ACTIVE_ORG: "server-admin:active-org",
	SERVER_ADMIN_ADD_MEMBER: "server-admin:add-member",
	SERVER_ADMIN_CREATE_ORG: "server-admin:create-org",
	SERVER_ADMIN_CREATE_ROLE: "server-admin:create-role",
	SERVER_ADMIN_DEACTIVATE_USER: "server-admin:deactivate-user",
	SERVER_ADMIN_DELETE_ORG: "server-admin:delete-org",
	SERVER_ADMIN_DELETE_ROLE: "server-admin:delete-role",
	SERVER_ADMIN_GET_QUOTAS: "server-admin:get-quotas",
	SERVER_ADMIN_GROUPS_LIST: "server-admin:groups-list",
	SERVER_ADMIN_GROUPS_PROJECTS: "server-admin:groups-projects",
	SERVER_ADMIN_GROUP_CREATE: "server-admin:group-create",
	SERVER_ADMIN_GROUP_UPDATE: "server-admin:group-update",
	SERVER_ADMIN_GROUP_DELETE: "server-admin:group-delete",
	SERVER_ADMIN_GROUP_SET_MEMBER: "server-admin:group-set-member",
	SERVER_ADMIN_GROUP_SET_PROJECT_ROLE: "server-admin:group-set-project-role",
	SERVER_ADMIN_LIST_AUDIT: "server-admin:list-audit",
	SERVER_ADMIN_LIST_MEMBERS: "server-admin:list-members",
	SERVER_ADMIN_LIST_ORGS: "server-admin:list-orgs",
	SERVER_ADMIN_LIST_ROLES: "server-admin:list-roles",
	SERVER_ADMIN_LIST_SESSIONS: "server-admin:list-sessions",
	SERVER_ADMIN_LIST_USERS: "server-admin:list-users",
	SERVER_ADMIN_MY_PERMISSIONS: "server-admin:my-permissions",
	SERVER_ADMIN_OVERVIEW: "server-admin:overview",
	SERVER_ADMIN_PERMISSIONS: "server-admin:permissions",
	SERVER_ADMIN_REMOVE_MEMBER: "server-admin:remove-member",
	SERVER_ADMIN_REVOKE_SESSIONS: "server-admin:revoke-sessions",
	SERVER_ADMIN_SET_ACTIVE_ORG: "server-admin:set-active-org",
	SERVER_ADMIN_SET_QUOTAS: "server-admin:set-quotas",
	SERVER_ADMIN_SWITCH_ORG: "server-admin:switch-org",
	SERVER_ADMIN_UPDATE_MEMBER_ROLE: "server-admin:update-member-role",
	SERVER_ADMIN_UPDATE_ORG: "server-admin:update-org",
	SERVER_ADMIN_UPDATE_ROLE: "server-admin:update-role",
	SERVER_AUTH_ACCEPT_INVITE: "server-auth:accept-invite",
	SERVER_AUTH_CREATE_INVITE: "server-auth:create-invite",
	SERVER_AUTH_GET_CONFIG: "server-auth:get-config",
	SERVER_AUTH_GET_STATE: "server-auth:get-state",
	SERVER_AUTH_LIST_INVITES: "server-auth:list-invites",
	SERVER_AUTH_LOGIN_ENTRA: "server-auth:login-entra",
	SERVER_AUTH_LOGIN_LOCAL: "server-auth:login-local",
	SERVER_AUTH_LOGOUT: "server-auth:logout",
	SERVER_AUTH_LOOKUP_INVITE: "server-auth:lookup-invite",
	SERVER_AUTH_RESTORE: "server-auth:restore",
	SERVER_AUTH_REVOKE_INVITE: "server-auth:revoke-invite",
	SERVER_AUTH_SET_MODE: "server-auth:set-mode",
	SERVER_AUTH_STATE_CHANGED: "server-auth:state-changed",
	// The person's own integration tokens on the server: listed by kind, set,
	// removed, never read back (main/server-user-secrets.ts).
	SERVER_AUTH_LIST_SECRETS: "server-auth:list-secrets",
	SERVER_AUTH_SET_SECRET: "server-auth:set-secret",
	SERVER_AUTH_DELETE_SECRET: "server-auth:delete-secret",
	// The person's theme on the server, read at connection (main/server-ui-preferences.ts).
	SERVER_AUTH_PULL_UI_PREFERENCES: "server-auth:pull-ui-preferences",
	// Server mode: register or delete a project on the server, for the team
	SERVER_PROJECT_CREATE: "server-project:create",
	SERVER_PROJECT_DELETE: "server-project:delete",
	// Server mode: follow a shown server board's changes live (main → renderer)
	SERVER_BOARD_WATCH: "server-board:watch",
	SERVER_BOARD_UNWATCH: "server-board:unwatch",
	SERVER_BOARD_LIVE: "server-board:live",
	// Server mode: follow a shown shared view of a server project (roadmap,
	// ideation, Insights, context) on the project's stream (main → renderer)
	SERVER_VIEW_WATCH: "server-view:watch",
	SERVER_VIEW_UNWATCH: "server-view:unwatch",
	SERVER_VIEW_CHANGED: "server-view:changed",
	// Server mode: a server project's dashboard, analytics, costs and session
	// history, computed by the server (main/server-workspace.ts)
	SERVER_WORKSPACE_COSTS: "server-workspace:costs",
	SERVER_WORKSPACE_DASHBOARD: "server-workspace:dashboard",
	SERVER_WORKSPACE_SESSIONS: "server-workspace:sessions",
	SMART_ESTIMATION_COMPLETE: "smart-estimation-complete",
	SMART_ESTIMATION_ERROR: "smart-estimation-error",
	SMART_ESTIMATION_EVENT: "smart-estimation-event",
	SPEC_APPROVAL_GET_SPEC: "specApproval:getSpec",
	SWARM_ANALYZE: "swarm:analyze",
	SWARM_CANCEL: "swarm:cancel",
	SWARM_EVENT: "swarm:event",
	SWARM_LOG: "swarm:log",
	SWARM_START: "swarm:start",
	SWARM_STATUS: "swarm:status",
	TASK_PAUSE: "TASK_PAUSE",
	TASK_RESUME: "TASK_RESUME",
	TEAM_BOT_SEND: "teamBot:send",
	TEAM_BOT_TEST: "teamBot:test",
	TECH_DEBT_GENERATE_SPEC: "techDebt:generateSpec",
	TECH_DEBT_GET_TREND: "techDebt:getTrend",
	TECH_DEBT_LIST_ITEMS: "techDebt:listItems",
	TECH_DEBT_SCAN: "techDebt:scan",
	TEST_GENERATION_ADD_PACKAGES: "test-generation:add-packages",
	TEST_GENERATION_ANALYZE_COVERAGE: "test-generation:analyze-coverage",
	TEST_GENERATION_CANCEL: "test-generation:cancel",
	TEST_GENERATION_CODE: "test-generation:code",
	TEST_GENERATION_COMPLETE: "test-generation:complete",
	TEST_GENERATION_ERROR: "test-generation:error",
	TEST_GENERATION_GENERATE_E2E: "test-generation:generate-e2e",
	TEST_GENERATION_GENERATE_TDD: "test-generation:generate-tdd",
	TEST_GENERATION_GENERATE_UNIT: "test-generation:generate-unit",
	TEST_GENERATION_PROGRESS: "test-generation:progress",
	TEST_GENERATION_RESOLVE_DESTINATION: "test-generation:resolve-destination",
	TEST_GENERATION_RESOLVE_LIBRARIES: "test-generation:resolve-libraries",
	TEST_GENERATION_RESULT: "test-generation:result",
	TEST_GENERATION_STATUS: "test-generation:status",
	USAGE_GET: "usage:get",
	USAGE_GET_ALL_DATA: "usage:getAllData",
	USAGE_GET_DATA: "usage:getData",
	USAGE_UPDATE_DATA: "usage:updateData",
	VISUAL_PROGRAMMING_CANCEL: "visualProgramming:cancel",
	VISUAL_PROGRAMMING_COMPLETE: "visualProgramming:complete",
	VISUAL_PROGRAMMING_ERROR: "visualProgramming:error",
	VISUAL_PROGRAMMING_FILE: "visualProgramming:file",
	VISUAL_PROGRAMMING_RUN: "visualProgramming:run",
	VISUAL_PROGRAMMING_STATUS: "visualProgramming:status",
	VISUAL_PROGRAMMING_WRITING: "visualProgramming:writing",
	VISUAL_TO_CODE_HISTORY_APPEND: "visualToCodeHistory:append",
	VISUAL_TO_CODE_HISTORY_DELETE_ALL: "visualToCodeHistory:deleteAll",
	VISUAL_TO_CODE_HISTORY_DELETE_VERSION: "visualToCodeHistory:deleteVersion",
	VISUAL_TO_CODE_HISTORY_GET: "visualToCodeHistory:get",
	VISUAL_TO_CODE_HISTORY_LABEL: "visualToCodeHistory:label",
	VISUAL_TO_CODE_HISTORY_LIST: "visualToCodeHistory:list",
	VOICE_CONTROL_AUDIO_LEVEL: "voice-control:audio-level",
	VOICE_CONTROL_CANCEL: "voice-control:cancel",
	VOICE_CONTROL_COMPLETE: "voice-control:complete",
	VOICE_CONTROL_DURATION: "voice-control:duration",
	VOICE_CONTROL_ERROR: "voice-control:error",
	VOICE_CONTROL_IS_ACTIVE: "voice-control:isActive",
	VOICE_CONTROL_START_RECORDING: "voice-control:startRecording",
	VOICE_CONTROL_STATUS: "voice-control:status",
	VOICE_CONTROL_STOP_RECORDING: "voice-control:stopRecording",
	VOICE_CONTROL_STREAM_CHUNK: "voice-control:stream-chunk",
} as const;
