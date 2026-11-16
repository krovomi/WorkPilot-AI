import { FolderGit, GitBranch, ListTodo, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	GitBranchDetail,
	Task,
	TerminalWorktreeConfig,
} from "../../../shared/types";
import { useToast } from "../../hooks/use-toast";
import { buildBranchOptions } from "../../lib/branch-utils";
import { useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { Combobox } from "../ui/combobox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

// Special value to represent "use project default" since Radix UI Select doesn't allow empty string values
const PROJECT_DEFAULT_BRANCH = "__project_default__";

/**
 * Sanitizes a string into a valid worktree/branch name.
 * - Converts to lowercase
 * - Replaces spaces and invalid characters with hyphens
 * - Collapses consecutive hyphens
 * - Trims leading and trailing hyphens/underscores, after the length cut, so the
 *   name starts and ends with a letter or digit (backend WORKTREE_NAME_REGEX)
 *
 * The field itself keeps what is typed (lowercased, spaces as hyphens): this
 * runs on it for the preview and the request.
 */
function sanitizeWorktreeName(value: string, maxLength?: number): string {
	let sanitized = value
		.toLowerCase()
		.replace(/\s+/g, "-") // Replace spaces with hyphens
		.replace(/[^a-z0-9_-]/g, "") // Remove invalid chars (only allow letters, numbers, hyphens, underscores)
		.replace(/-{2,}/g, "-") // Collapse consecutive hyphens
		.replace(/_{2,}/g, "_") // Collapse consecutive underscores
		.replace(/^[-_]+/, ""); // Trim leading hyphens/underscores only

	if (maxLength) {
		sanitized = sanitized.slice(0, maxLength);
	}

	return sanitized.replace(/[-_]+$/, "");
}

interface CreateWorktreeDialogProps {
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when the dialog open state changes */
	onOpenChange: (open: boolean) => void;
	/** Terminal ID to associate with the worktree */
	terminalId: string;
	/** Project path for worktree creation (the dialog is only mounted with one) */
	projectPath: string;
	/** Available backlog tasks for linking */
	backlogTasks: Task[];
	/** Callback when worktree is successfully created */
	onWorktreeCreated: (config: TerminalWorktreeConfig) => void;
}

export function CreateWorktreeDialog({
	open,
	onOpenChange,
	terminalId,
	projectPath,
	backlogTasks,
	onWorktreeCreated,
}: CreateWorktreeDialogProps) {
	const { t } = useTranslation(["terminal", "common"]);
	const { toast } = useToast();
	const [name, setName] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
	const [createGitBranch, setCreateGitBranch] = useState(true);
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Get project settings for default branch
	const project = useProjectStore((state) =>
		state.projects.find((p) => p.path === projectPath),
	);

	// Branch selection state - using structured GitBranchDetail for type indicators
	const [branches, setBranches] = useState<GitBranchDetail[]>([]);
	const [isLoadingBranches, setIsLoadingBranches] = useState(false);
	const [baseBranch, setBaseBranch] = useState<string>(PROJECT_DEFAULT_BRANCH);
	const [projectDefaultBranch, setProjectDefaultBranch] = useState<string>("");

	// Sanitized name for validation (without display fallback)
	const sanitizedName = useMemo(
		() => sanitizeWorktreeName(name),
		[name],
	);

	// Preview name with fallback for display (using i18n)
	const previewName = sanitizedName || t("terminal:worktree.namePlaceholder");

	// Fetch branches when dialog opens
	useEffect(() => {
		if (!open) return;

		let isMounted = true;

		const fetchBranches = async () => {
			setIsLoadingBranches(true);
			try {
				// Use structured branch data with type indicators
				const result =
					await window.electronAPI.getGitBranchesWithInfo(projectPath);
				if (!isMounted) return;

				if (result.success && result.data) {
					setBranches(result.data);
				}

				// Use project settings mainBranch if available, otherwise auto-detect
				if (project?.settings?.mainBranch) {
					setProjectDefaultBranch(project.settings.mainBranch);
				} else {
					// Fallback to auto-detect if no project setting
					const defaultResult =
						await window.electronAPI.detectMainBranch(projectPath);
					if (!isMounted) return;

					if (defaultResult.success && defaultResult.data) {
						setProjectDefaultBranch(defaultResult.data);
					}
				}
			} catch (err) {
				console.error("Failed to fetch branches:", err);
			} finally {
				if (isMounted) {
					setIsLoadingBranches(false);
				}
			}
		};

		fetchBranches();

		return () => {
			isMounted = false;
		};
	}, [open, projectPath, project?.settings?.mainBranch]);

	const handleNameChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			// Apply lowercase and convert spaces to hyphens as user types
			// This reduces the visual gap between input and preview
			// Full sanitization (removing invalid chars) happens on submit
			const rawValue = e.target.value.toLowerCase().replace(/\s+/g, "-");
			setName(rawValue);
			setError(null);
		},
		[],
	);

	const handleTaskSelect = useCallback(
		(taskId: string) => {
			if (taskId === "none") {
				setSelectedTaskId(undefined);
				return;
			}
			setSelectedTaskId(taskId);
			// Auto-fill name from task if empty
			// The options are built from backlogTasks, so the task is there.
			if (!name) {
				const task = backlogTasks.find((t) => t.id === taskId) as Task;
				setName(sanitizeWorktreeName(task.title, 40));
			}
		},
		[backlogTasks, name],
	);

	// Determine if the selected branch is local (for useLocalBranch flag)
	const isSelectedBranchLocal = useMemo(() => {
		if (baseBranch === PROJECT_DEFAULT_BRANCH) return false;
		const selectedGitBranchDetail = branches.find((b) => b.name === baseBranch);
		return selectedGitBranchDetail?.type === "local";
	}, [baseBranch, branches]);

	const resetForm = () => {
		setName("");
		setSelectedTaskId(undefined);
		setCreateGitBranch(true);
		setBaseBranch(PROJECT_DEFAULT_BRANCH);
		setError(null);
	};

	const handleCreate = async () => {
		// The button is only enabled for a non-empty sanitized name, and the
		// sanitizer only keeps [a-z0-9_-] with letters or digits at both ends:
		// exactly what the main process accepts (WORKTREE_NAME_REGEX), which
		// checks it again.
		setIsCreating(true);
		setError(null);

		try {
			const result = await window.electronAPI.createTerminalWorktree({
				terminalId,
				name: sanitizedName,
				taskId: selectedTaskId,
				createGitBranch,
				projectPath,
				// Only include baseBranch if not using project default
				baseBranch:
					baseBranch !== PROJECT_DEFAULT_BRANCH ? baseBranch : undefined,
				// Set useLocalBranch when user explicitly selects a local branch
				// This preserves gitignored files (.env, configs) by not switching to origin
				useLocalBranch: isSelectedBranchLocal,
			});

			if (result.success && result.config) {
				onWorktreeCreated(result.config);
				onOpenChange(false);
				resetForm();
				// The worktree is usable; say that tracking was not set up. git's own
				// message stays in the main process log: it is untranslated.
				if (result.warning) {
					toast({
						title: t("terminal:worktree.remotePushFailed"),
						description: t("terminal:worktree.remotePushFailedDescription"),
						variant: "destructive",
					});
				}
			} else {
				setError(result.error || t("common:errors.generic"));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("common:errors.generic"));
		} finally {
			setIsCreating(false);
		}
	};

	// Only the terminal opens the dialog (it has no trigger of its own), so
	// every change Radix reports here is a close: Escape, the overlay, the X.
	const handleClose = () => {
		resetForm();
		onOpenChange(false);
	};

	// Build branch options using shared utility - groups by local/remote with type indicators
	const branchOptions = useMemo(() => {
		return buildBranchOptions(branches, {
			t,
			includeProjectDefault: {
				value: PROJECT_DEFAULT_BRANCH,
				branchName: projectDefaultBranch || "main",
				labelKey: "terminal:worktree.useProjectDefault",
			},
		});
	}, [branches, projectDefaultBranch, t]);

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderGit className="h-5 w-5" />
						{t("terminal:worktree.createTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("terminal:worktree.createDescription")}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					{/* Worktree Name */}
					<div className="space-y-2">
						<Label htmlFor="worktree-name">{t("terminal:worktree.name")}</Label>
						<Input
							id="worktree-name"
							value={name}
							onChange={handleNameChange}
							placeholder={t("terminal:worktree.namePlaceholder")}
							disabled={isCreating}
							autoFocus
						/>
						<p className="text-xs text-muted-foreground">
							{t("terminal:worktree.nameHelp")}
						</p>
					</div>

					{/* Task Association (Optional) */}
					<div className="space-y-2">
						<Label htmlFor="worktree-task" className="flex items-center gap-2">
							<ListTodo className="h-4 w-4" />
							{t("terminal:worktree.associateTask")}
							<span className="text-muted-foreground text-xs">
								({t("common:labels.optional")})
							</span>
						</Label>
						<Select
							value={selectedTaskId || "none"}
							onValueChange={handleTaskSelect}
						>
							<SelectTrigger id="worktree-task">
								<SelectValue placeholder={t("terminal:worktree.selectTask")} />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">
									{t("terminal:worktree.noTask")}
								</SelectItem>
								{backlogTasks.slice(0, 10).map((task) => (
									<SelectItem key={task.id} value={task.id}>
										<span className="truncate max-w-[300px]">{task.title}</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Git Branch Toggle */}
					<div className="flex items-center justify-between space-x-2 rounded-lg border p-3">
						<div className="space-y-0.5">
							<Label
								htmlFor="create-branch"
								className="flex items-center gap-2 cursor-pointer"
							>
								<GitBranch className="h-4 w-4" />
								{t("terminal:worktree.createBranch")}
							</Label>
							<p className="text-xs text-muted-foreground">
								{t("terminal:worktree.branchHelp", {
									branch: `terminal/${previewName}`,
								})}
							</p>
						</div>
						<Switch
							id="create-branch"
							checked={createGitBranch}
							onCheckedChange={setCreateGitBranch}
							disabled={isCreating}
						/>
					</div>

					{/* Base Branch Selection - Searchable */}
					<div className="space-y-2">
						<Label htmlFor="base-branch" className="flex items-center gap-2">
							<GitBranch className="h-4 w-4" />
							{t("terminal:worktree.baseBranch")}
						</Label>
						<Combobox
							id="base-branch"
							value={baseBranch}
							onValueChange={setBaseBranch}
							options={branchOptions}
							placeholder={t("terminal:worktree.selectBaseBranch")}
							searchPlaceholder={t("terminal:worktree.searchBranch")}
							emptyMessage={t("terminal:worktree.noBranchFound")}
							disabled={isCreating || isLoadingBranches}
						/>
						<p className="text-xs text-muted-foreground">
							{t("terminal:worktree.baseBranchHelp")}
						</p>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleClose}
						disabled={isCreating}
					>
						{t("common:buttons.cancel")}
					</Button>
					<Button
						onClick={handleCreate}
						disabled={isCreating || !sanitizedName}
					>
						{isCreating ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								{t("common:labels.creating")}
							</>
						) : (
							t("common:buttons.create")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
