import type { Project } from "@shared/types";
import {
	Building,
	CheckCircle2,
	ChevronRight,
	GitBranch,
	Globe,
	Key,
	Link,
	Loader2,
	Lock,
	Plus,
	Sparkles,
	User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClaudeOAuthFlow } from "./project-settings/ClaudeOAuthFlow";
import { GitHubOAuthFlow } from "./project-settings/GitHubOAuthFlow";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

interface GitHubSetupModalProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly project: Project;
	readonly onComplete: (settings: {
		githubToken: string;
		githubRepo: string;
		mainBranch: string;
		githubAuthMethod?: "oauth" | "pat";
	}) => void;
	readonly onSkip?: () => void;
}

type SetupStep =
	| "github-auth"
	| "claude-auth"
	| "repo-confirm"
	| "repo"
	| "branch";

/**
 * Setup Modal - Required setup flow after WorkPilot AI initialization
 *
 * Flow:
 * 1. Authenticate with GitHub (via gh CLI OAuth) - for repo operations
 * 2. Authenticate with Claude (via claude CLI OAuth) - for AI features
 * 3. Detect/confirm repository
 * 4. Select a base branch for tasks (with recommended default)
 */
export function GitHubSetupModal({
	open,
	onOpenChange,
	project,
	onComplete,
	onSkip,
}: GitHubSetupModalProps) {
	const { t } = useTranslation("dialogs");
	const [step, setStep] = useState<SetupStep>("github-auth");
	const [githubToken, setGithubToken] = useState<string | null>(null);
	const [githubRepo, setGithubRepo] = useState<string | null>(null);
	const [detectedRepo, setDetectedRepo] = useState<string | null>(null);
	const [branches, setBranches] = useState<string[]>([]);
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const [recommendedBranch, setRecommendedBranch] = useState<string | null>(
		null,
	);
	const [isLoadingBranches, setIsLoadingBranches] = useState(false);
	const [isLoadingRepo, setIsLoadingRepo] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Repo setup state (for when no remote is detected)
	const [repoAction, setRepoAction] = useState<"create" | "link" | null>(null);
	const [newRepoName, setNewRepoName] = useState("");
	const [isPrivateRepo, setIsPrivateRepo] = useState(true);
	const [existingRepoName, setExistingRepoName] = useState("");
	const [isCreatingRepo, setIsCreatingRepo] = useState(false);

	// Organization selection state
	const [githubUsername, setGithubUsername] = useState<string | null>(null);
	const [organizations, setOrganizations] = useState<
		Array<{ login: string; avatarUrl?: string }>
	>([]);
	const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
	const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);

	// Load user info and organizations
	const loadUserAndOrgs = async () => {
		setIsLoadingOrgs(true);
		try {
			// Get current user
			const userResult = await globalThis.electronAPI.getGitHubUser();
			if (userResult.success && userResult.data) {
				setGithubUsername(userResult.data.username);
				setSelectedOwner(userResult.data.username); // Default to personal account
			}

			// Get organizations
			const orgsResult = await globalThis.electronAPI.listGitHubOrgs();
			if (orgsResult.success && orgsResult.data) {
				setOrganizations(orgsResult.data.orgs);
			}
		} catch (err) {
			console.error("Failed to load user/orgs:", err);
		} finally {
			setIsLoadingOrgs(false);
		}
	};

	// Detect repository from git remote when auth succeeds
	const detectRepository = async () => {
		setIsLoadingRepo(true);
		setError(null);

		try {
			// Try to detect repo from git remote
			const result = await globalThis.electronAPI.detectGitHubRepo(
				project.path,
			);
			if (result.success && result.data) {
				setDetectedRepo(result.data);
				setGithubRepo(result.data);
				// Go to confirmation step instead of directly to branch
				setStep("repo-confirm");
			} else {
				// No remote detected, load orgs and show repo setup step
				await loadUserAndOrgs();
				setStep("repo");
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("dialogs:githubSetup.errors.detectFailed"),
			);
			await loadUserAndOrgs();
			setStep("repo");
		} finally {
			setIsLoadingRepo(false);
		}
	};

	// Reset state and check existing auth when modal opens. Only on open:
	// `detectRepository` is a new function each render, and as a dependency it
	// re-ran this reset after every render, a loop React stops with "Maximum
	// update depth exceeded".
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on open only, see above
	useEffect(() => {
		if (open) {
			// Reset all state first
			setGithubToken(null);
			setGithubRepo(null);
			setDetectedRepo(null);
			setBranches([]);
			setSelectedBranch(null);
			setRecommendedBranch(null);
			setError(null);
			// Reset repo setup state
			setRepoAction(null);
			setNewRepoName(project.name.replaceAll(/[^A-Za-z0-9_.-]/g, "-"));
			setIsPrivateRepo(true);
			setExistingRepoName("");
			setIsCreatingRepo(false);
			// Reset organization state
			setGithubUsername(null);
			setOrganizations([]);
			setSelectedOwner(null);
			setIsLoadingOrgs(false);

			// Check for existing authentication and skip to appropriate step
			const checkExistingAuth = async () => {
				try {
					// Check for existing GitHub token
					const ghTokenResult = await globalThis.electronAPI.getGitHubToken();
					const hasGitHubAuth =
						ghTokenResult.success && ghTokenResult.data?.token;

					// Check for existing Claude authentication
					const profilesResult =
						await globalThis.electronAPI.getClaudeProfiles();
					let hasClaudeAuth = false;
					if (profilesResult.success && profilesResult.data) {
						const activeProfile = profilesResult.data.profiles.find(
							(p) => p.id === profilesResult.data?.activeProfileId,
						);
						hasClaudeAuth = !!(
							activeProfile?.oauthToken ||
							(activeProfile?.isDefault && activeProfile?.configDir)
						);
					}

					// Determine starting step based on existing auth
					if (hasGitHubAuth && hasClaudeAuth) {
						// Both authenticated, go directly to repo detection
						setGithubToken(ghTokenResult.data?.token ?? null);
						// detectRepository will be called and set the step
						setStep("repo"); // Temporary, detectRepository will update
						await detectRepository();
					} else if (hasGitHubAuth) {
						// Only GitHub authenticated, go to Claude auth
						setGithubToken(ghTokenResult.data?.token ?? null);
						setStep("claude-auth");
					} else {
						// No auth, start from beginning
						setStep("github-auth");
					}
				} catch (err) {
					console.error("Failed to check existing auth:", err);
					// On error, start from beginning
					setStep("github-auth");
				}
			};

			checkExistingAuth();
		}
	}, [open]);

	// Load branches from GitHub
	const loadBranches = async (repo: string) => {
		setIsLoadingBranches(true);
		setError(null);

		try {
			// Get branches from GitHub API
			const result = await globalThis.electronAPI.getGitHubBranches(
				repo,
				githubToken ?? "",
			);
			if (result.success && result.data) {
				setBranches(result.data);

				// Detect recommended branch (main > master > develop > first)
				const recommended = detectRecommendedBranch(result.data);
				setRecommendedBranch(recommended);
				setSelectedBranch(recommended);
			} else {
				setError(result.error || t("dialogs:githubSetup.errors.branchesFailed"));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("dialogs:githubSetup.errors.branchesFailed"));
		} finally {
			setIsLoadingBranches(false);
		}
	};

	// Detect recommended branch from list
	const detectRecommendedBranch = (branchList: string[]): string | null => {
		const priorities = ["main", "master", "develop", "dev"];
		for (const priority of priorities) {
			if (branchList.includes(priority)) {
				return priority;
			}
		}
		return branchList[0] || null;
	};

	// Handle GitHub OAuth success
	const handleGitHubAuthSuccess = async (token: string) => {
		setGithubToken(token);

		// Check if Claude is already authenticated before showing auth step
		try {
			const profilesResult = await globalThis.electronAPI.getClaudeProfiles();
			if (profilesResult.success && profilesResult.data) {
				const activeProfile = profilesResult.data.profiles.find(
					(p) => p.id === profilesResult.data?.activeProfileId,
				);
				// Check if active profile has authentication (oauthToken or default with configDir)
				if (
					activeProfile?.oauthToken ||
					(activeProfile?.isDefault && activeProfile?.configDir)
				) {
					// Already authenticated, skip Claude auth and go directly to repo detection
					await detectRepository();
					return;
				}
			}
		} catch (err) {
			console.error("Failed to check Claude profiles:", err);
			// On error, fall through to show Claude auth step
		}

		// Not authenticated, show Claude auth step
		setStep("claude-auth");
	};

	// Handle Claude OAuth success
	const handleClaudeAuthSuccess = async () => {
		// Claude token is already saved to active profile by the OAuth flow
		// Move to repo detection
		await detectRepository();
	};

	// Handle creating a new GitHub repository
	// The Create button stays disabled until a name is typed.
	const handleCreateRepo = async () => {
		if (!selectedOwner) {
			setError(t("dialogs:githubSetup.errors.ownerRequired"));
			return;
		}

		setIsCreatingRepo(true);
		setError(null);

		try {
			const result = await globalThis.electronAPI.createGitHubRepo(
				newRepoName.trim(),
				{
					isPrivate: isPrivateRepo,
					projectPath: project.path,
					owner: selectedOwner === githubUsername ? undefined : selectedOwner, // Only pass owner if it's an org
				},
			);

			if (result.success && result.data) {
				// Repo created and remote added automatically by gh CLI
				setGithubRepo(result.data.fullName);
				setDetectedRepo(result.data.fullName);
				setStep("branch");
				await loadBranches(result.data.fullName);
			} else {
				setError(result.error || t("dialogs:githubSetup.errors.createFailed"));
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("dialogs:githubSetup.errors.createFailed"),
			);
		} finally {
			setIsCreatingRepo(false);
		}
	};

	// Handle confirming the detected repository
	const handleConfirmRepo = async () => {
		if (detectedRepo) {
			setStep("branch");
			await loadBranches(detectedRepo);
		}
	};

	// Handle changing the repository (go to repo setup)
	const handleChangeRepo = async () => {
		await loadUserAndOrgs();
		setStep("repo");
	};

	// Handle linking to an existing GitHub repository
	// The Link button stays disabled until a repository is typed.
	const handleLinkRepo = async () => {
		// Validate format
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(existingRepoName.trim())) {
			setError(t("dialogs:githubSetup.errors.repoPathInvalid"));
			return;
		}

		setIsCreatingRepo(true);
		setError(null);

		try {
			const result = await globalThis.electronAPI.addGitRemote(
				project.path,
				existingRepoName.trim(),
			);

			if (result.success) {
				setGithubRepo(existingRepoName.trim());
				setDetectedRepo(existingRepoName.trim());
				setStep("branch");
				await loadBranches(existingRepoName.trim());
			} else {
				setError(result.error || t("dialogs:githubSetup.errors.linkFailed"));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("dialogs:githubSetup.errors.linkFailed"));
		} finally {
			setIsCreatingRepo(false);
		}
	};

	// Handle branch selection complete
	const handleComplete = () => {
		if (githubToken && githubRepo && selectedBranch) {
			onComplete({
				githubToken,
				githubRepo,
				mainBranch: selectedBranch,
				githubAuthMethod: "oauth", // Setup modal always uses OAuth flow
			});
		}
	};

	// Helper function to get step progress index
	const getStepProgressIndex = (currentStep: SetupStep): number => {
		const authSteps: SetupStep[] = [
			"github-auth",
			"claude-auth",
			"repo-confirm",
			"repo",
		];
		return authSteps.includes(currentStep) ? 0 : 1;
	};

	// Step content, called as functions: as <Components /> defined inside this one, each
	// render made them new types, so React remounted them and the inputs lost focus.
	const renderGitHubAuthStep = () => (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Globe className="h-5 w-5" />
					{t("githubSetup.connectTitle")}
				</DialogTitle>
				<DialogDescription>
					{t("githubSetup.connectDescription")}
				</DialogDescription>
			</DialogHeader>

			<div className="py-4">
				<GitHubOAuthFlow
					onSuccess={handleGitHubAuthSuccess}
					onCancel={onSkip}
				/>
			</div>
		</>
	);

	const renderClaudeAuthStep = () => (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Key className="h-5 w-5" />
					{t("githubSetup.claudeTitle")}
				</DialogTitle>
				<DialogDescription>
					{t("githubSetup.claudeDescription")}
				</DialogDescription>
			</DialogHeader>

			<div className="py-4">
				<ClaudeOAuthFlow
					onSuccess={handleClaudeAuthSuccess}
					onCancel={onSkip}
				/>
			</div>
		</>
	);

	const renderRepoConfirmStep = () => (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Globe className="h-5 w-5" />
					{t("dialogs:githubSetup.confirmRepo")}
				</DialogTitle>
				<DialogDescription>
					{t("dialogs:githubSetup.confirmRepoDescription")}
				</DialogDescription>
			</DialogHeader>

			<div className="py-4 space-y-4">
				<div className="rounded-lg border bg-muted/50 p-4">
					<div className="flex items-center gap-3">
						<CheckCircle2 className="h-6 w-6 text-success" />
						<div>
							<p className="font-medium">{t("dialogs:githubSetup.repoDetected")}</p>
							<p className="text-sm text-muted-foreground font-mono">
								{detectedRepo}
							</p>
						</div>
					</div>
				</div>

				<p className="text-sm text-muted-foreground">
					{t("githubSetup.repoDescription")}
				</p>

				{error && (
					<div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
						{error}
					</div>
				)}
			</div>

			<DialogFooter>
				<Button variant="outline" onClick={handleChangeRepo}>
					{t("dialogs:githubSetup.useDifferentRepo")}
				</Button>
				<Button onClick={handleConfirmRepo}>
					<CheckCircle2 className="mr-2 h-4 w-4" />
					{t("dialogs:githubSetup.confirmContinue")}
				</Button>
			</DialogFooter>
		</>
	);

	const renderRepoStep = () => (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<Globe className="h-5 w-5" />
					{t("dialogs:githubSetup.connectTitle")}
				</DialogTitle>
				<DialogDescription>
					{t("dialogs:githubSetup.needsRepo")}
				</DialogDescription>
			</DialogHeader>

			<div className="py-4 space-y-4">
				{/* Action selection */}
				{!repoAction && (
					<div className="grid grid-cols-2 gap-3">
						<button
							type="button"
							onClick={() => setRepoAction("create")}
							className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors"
							aria-label={t("githubSetup.createRepoAriaLabel")}
						>
							<Plus className="h-8 w-8 text-muted-foreground" />
							<span className="text-sm font-medium">{t("dialogs:githubSetup.createNewRepo")}</span>
							<span className="text-xs text-muted-foreground text-center">
								{t("dialogs:githubSetup.createNewRepoDescription")}
							</span>
						</button>
						<button
							type="button"
							onClick={() => setRepoAction("link")}
							className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors"
							aria-label={t("githubSetup.linkRepoAriaLabel")}
						>
							<Link className="h-8 w-8 text-muted-foreground" />
							<span className="text-sm font-medium">{t("dialogs:githubSetup.linkExisting")}</span>
							<span className="text-xs text-muted-foreground text-center">
								{t("dialogs:githubSetup.linkExistingDescription")}
							</span>
						</button>
					</div>
				)}

				{/* Create new repo form */}
				{repoAction === "create" && renderCreateRepoForm()}

				{/* Link existing repo form */}
				{repoAction === "link" && renderLinkRepoForm()}

				{error && (
					<div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
						{error}
					</div>
				)}
			</div>

			<DialogFooter>
				{onSkip && (
					<Button variant="outline" onClick={onSkip} disabled={isCreatingRepo}>
						{t("dialogs:githubSetup.skipForNow")}
					</Button>
				)}
				{repoAction === "create" && (
					<Button
						onClick={handleCreateRepo}
						disabled={isCreatingRepo || !newRepoName.trim()}
					>
						{isCreatingRepo ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("common:buttons.creating")}
							</>
						) : (
							<>
								<Plus className="mr-2 h-4 w-4" />
								{t("dialogs:githubSetup.createRepo")}
							</>
						)}
					</Button>
				)}
				{repoAction === "link" && (
					<Button
						onClick={handleLinkRepo}
						disabled={isCreatingRepo || !existingRepoName.trim()}
					>
						{isCreatingRepo ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("dialogs:githubSetup.linking")}
							</>
						) : (
							<>
								<Link className="mr-2 h-4 w-4" />
								{t("dialogs:githubSetup.linkRepo")}
							</>
						)}
					</Button>
				)}
				{!repoAction && (
					<Button
						variant="outline"
						onClick={detectRepository}
						disabled={isLoadingRepo}
					>
						{isLoadingRepo ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								{t("dialogs:githubSetup.checking")}
							</>
						) : (
							t("dialogs:githubSetup.retryDetection")
						)}
					</Button>
				)}
			</DialogFooter>
		</>
	);

	const renderCreateRepoForm = () => (
		<div className="space-y-4">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<button
					type="button"
					onClick={() => setRepoAction(null)}
					className="text-primary hover:underline"
					aria-label={t("githubSetup.goBackAriaLabel")}
				>
					{t("dialogs:githubSetup.back")}
				</button>
				<span>{t("dialogs:githubSetup.createRepoTitle")}</span>
			</div>

			{/* Owner selection */}
			{renderOwnerSelection()}

			<div className="space-y-2">
				<Label htmlFor="repo-name">{t("dialogs:githubSetup.repoName")}</Label>
				<div className="flex items-center gap-2">
					<span className="text-sm text-muted-foreground">
						{selectedOwner || "..."} /
					</span>
					<Input
						id="repo-name"
						value={newRepoName}
						onChange={(e) => setNewRepoName(e.target.value)}
						placeholder="my-project"
						disabled={isCreatingRepo}
						className="flex-1"
					/>
				</div>
			</div>

			{renderVisibilitySelection()}
		</div>
	);

	const renderOwnerSelection = () => (
		<div className="space-y-2">
			<Label>{t("dialogs:githubSetup.owner")}</Label>
			{isLoadingOrgs ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					{t("dialogs:githubSetup.loadingAccounts")}
				</div>
			) : (
				<div
					className="flex flex-wrap gap-2"
					role="radiogroup"
					aria-label={t("common:accessibility.repositoryOwnerAriaLabel")}
				>
					{/* Personal account */}
					{githubUsername && (
						// biome-ignore lint/a11y/useSemanticElements: custom styled radio button within radiogroup
						<button
							type="button"
							onClick={() => setSelectedOwner(githubUsername)}
							className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
								selectedOwner === githubUsername
									? "border-primary bg-primary/10 text-primary"
									: "border-muted hover:border-primary/50"
							}`}
							disabled={isCreatingRepo}
							role="radio"
							aria-checked={selectedOwner === githubUsername}
							aria-label={t("githubSetup.selectOwnerAriaLabel", {
								owner: githubUsername,
							})}
						>
							<User className="h-4 w-4" />
							<span className="text-sm">{githubUsername}</span>
						</button>
					)}
					{/* Organizations */}
					{organizations.map((org) => (
						// biome-ignore lint/a11y/useSemanticElements: custom styled radio button within radiogroup
						<button
							type="button"
							key={org.login}
							onClick={() => setSelectedOwner(org.login)}
							className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
								selectedOwner === org.login
									? "border-primary bg-primary/10 text-primary"
									: "border-muted hover:border-primary/50"
							}`}
							disabled={isCreatingRepo}
							role="radio"
							aria-checked={selectedOwner === org.login}
							aria-label={t("githubSetup.selectOrgAriaLabel", {
								org: org.login,
							})}
						>
							<Building className="h-4 w-4" />
							<span className="text-sm">{org.login}</span>
						</button>
					))}
				</div>
			)}
			{organizations.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("dialogs:githubSetup.ownerHint")}
				</p>
			)}
		</div>
	);

	const renderVisibilitySelection = () => (
		<div className="space-y-2">
			<Label>{t("dialogs:githubSetup.visibility")}</Label>
			<div
				className="flex gap-2"
				role="radiogroup"
				aria-label={t("common:accessibility.repositoryVisibilityAriaLabel")}
			>
				{/* biome-ignore lint/a11y/useSemanticElements: custom styled radio button within radiogroup */}
				<button
					type="button"
					onClick={() => setIsPrivateRepo(true)}
					className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
						isPrivateRepo
							? "border-primary bg-primary/10 text-primary"
							: "border-muted hover:border-primary/50"
					}`}
					disabled={isCreatingRepo}
					role="radio"
					aria-checked={isPrivateRepo}
					aria-label={t("githubSetup.selectVisibilityAriaLabel", {
						visibility: t("dialogs:githubSetup.private"),
					})}
				>
					<Lock className="h-4 w-4" />
					<span className="text-sm">{t("dialogs:githubSetup.private")}</span>
				</button>
				{/* biome-ignore lint/a11y/useSemanticElements: custom styled radio button within radiogroup */}
				<button
					type="button"
					onClick={() => setIsPrivateRepo(false)}
					className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
						isPrivateRepo
							? "border-muted hover:border-primary/50"
							: "border-primary bg-primary/10 text-primary"
					}`}
					disabled={isCreatingRepo}
					role="radio"
					aria-checked={!isPrivateRepo}
					aria-label={t("githubSetup.selectVisibilityAriaLabel", {
						visibility: t("dialogs:githubSetup.public"),
					})}
				>
					<Globe className="h-4 w-4" />
					<span className="text-sm">{t("dialogs:githubSetup.public")}</span>
				</button>
			</div>
		</div>
	);

	const renderLinkRepoForm = () => (
		<div className="space-y-4">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<button
					type="button"
					onClick={() => setRepoAction(null)}
					className="text-primary hover:underline"
					aria-label={t("githubSetup.goBackAriaLabel")}
				>
					{t("dialogs:githubSetup.back")}
				</button>
				<span>{t("dialogs:githubSetup.linkRepoTitle")}</span>
			</div>

			<div className="space-y-2">
				<Label htmlFor="existing-repo">{t("dialogs:githubSetup.repositoryLabel")}</Label>
				<Input
					id="existing-repo"
					value={existingRepoName}
					onChange={(e) => setExistingRepoName(e.target.value)}
					placeholder="username/repository"
					disabled={isCreatingRepo}
				/>
				<p className="text-xs text-muted-foreground">
					{t("dialogs:githubSetup.repoPathHint")}
				</p>
			</div>
		</div>
	);

	const renderBranchStep = () => (
		<>
			<DialogHeader>
				<DialogTitle className="flex items-center gap-2">
					<GitBranch className="h-5 w-5" />
					{t("dialogs:githubSetup.selectBranch")}
				</DialogTitle>
				<DialogDescription>
					{t("dialogs:githubSetup.branchDescription")}
				</DialogDescription>
			</DialogHeader>

			<div className="py-4 space-y-4">
				{/* Show detected repo */}
				{detectedRepo && (
					<div className="flex items-center gap-2 text-sm">
						<Globe className="h-4 w-4 text-muted-foreground" />
						<span className="text-muted-foreground">{t("dialogs:githubSetup.repositoryPrefix")}</span>
						<code className="px-2 py-0.5 bg-muted rounded font-mono text-xs">
							{detectedRepo}
						</code>
						<CheckCircle2 className="h-4 w-4 text-success" />
					</div>
				)}

				{/* Branch selector */}
				{renderBranchSelector()}

				{/* Info about branch selection */}
				<div className="rounded-lg border border-info/30 bg-info/5 p-3">
					<div className="flex items-start gap-2">
						<Sparkles className="h-4 w-4 text-info mt-0.5" />
						<div className="text-xs text-muted-foreground">
							<p className="font-medium text-foreground">
								{t("dialogs:githubSetup.whyBranch")}
							</p>
							<p className="mt-1">
								{t("dialogs:githubSetup.branchExplanation")}
							</p>
						</div>
					</div>
				</div>

				{error && (
					<div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
						{error}
					</div>
				)}
			</div>

			<DialogFooter>
				{onSkip && (
					<Button variant="outline" onClick={onSkip}>
						{t("dialogs:githubSetup.skipForNow")}
					</Button>
				)}
				<Button
					onClick={handleComplete}
					disabled={!selectedBranch || isLoadingBranches}
				>
					<CheckCircle2 className="mr-2 h-4 w-4" />
					{t("dialogs:githubSetup.completeSetup")}
				</Button>
			</DialogFooter>
		</>
	);

	const renderBranchSelector = () => (
		<div className="space-y-2">
			<Label>{t("dialogs:githubSetup.baseBranch")}</Label>
			<Select
				value={selectedBranch || ""}
				onValueChange={setSelectedBranch}
				disabled={isLoadingBranches || branches.length === 0}
			>
				<SelectTrigger>
					{isLoadingBranches ? (
						<div className="flex items-center gap-2">
							<Loader2 className="h-3 w-3 animate-spin" />
							<span>{t("dialogs:githubSetup.loadingBranches")}</span>
						</div>
					) : (
						<SelectValue placeholder={t("dialogs:githubSetup.selectBranchPlaceholder")} />
					)}
				</SelectTrigger>
				<SelectContent>
					{branches.map((branch) => (
						<SelectItem key={branch} value={branch}>
							<div className="flex items-center gap-2">
								<span>{branch}</span>
								{branch === recommendedBranch && (
									<span className="flex items-center gap-1 text-xs text-success">
										<Sparkles className="h-3 w-3" />
										{t("dialogs:githubSetup.recommended")}
									</span>
								)}
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-xs text-muted-foreground">
				{t("dialogs:githubSetup.branchHintBefore")}{" "}
				<code className="px-1 bg-muted rounded">auto-claude/task-name</code>
				{selectedBranch && (
					<>
						{" "}
						{t("dialogs:githubSetup.branchHintBasedOn")}{" "}
						<code className="px-1 bg-muted rounded">{selectedBranch}</code>
					</>
				)}
			</p>
		</div>
	);

	// Render step content
	const renderStepContent = () => {
		switch (step) {
			case "github-auth":
				return renderGitHubAuthStep();
			case "claude-auth":
				return renderClaudeAuthStep();
			case "repo-confirm":
				return renderRepoConfirmStep();
			case "repo":
				return renderRepoStep();
			case "branch":
				return renderBranchStep();
		}
	};

	// Progress indicator
	// Helper function to get step progress styling
	const getStepProgressClass = (
		stepIndex: number,
		currentProgressIndex: number,
	): string => {
		if (stepIndex < currentProgressIndex) {
			return "bg-success text-success-foreground";
		}
		if (stepIndex === currentProgressIndex) {
			return "bg-primary text-primary-foreground";
		}
		return "bg-muted text-muted-foreground";
	};

	const renderProgress = () => {
		const steps: { label: string }[] = [
			{ label: t("dialogs:githubSetup.progressAuthenticate") },
			{ label: t("dialogs:githubSetup.progressConfigure") },
		];

		// Map steps to progress indices
		// Auth steps (github-auth, claude-auth, repo-confirm, repo) = 0
		// Config steps (branch) = 1
		const currentIndex = getStepProgressIndex(step);

		return (
			<div className="flex items-center justify-center gap-2 mb-4">
				{steps.map((s, index) => (
					<div key={s.label} className="flex items-center">
						<div
							className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${getStepProgressClass(index, currentIndex)}`}
						>
							{index < currentIndex ? (
								<CheckCircle2 className="h-4 w-4" />
							) : (
								index + 1
							)}
						</div>
						<span
							className={`ml-2 text-xs ${
								index === currentIndex
									? "text-foreground font-medium"
									: "text-muted-foreground"
							}`}
						>
							{s.label}
						</span>
						{index < steps.length - 1 && (
							<ChevronRight className="h-4 w-4 mx-2 text-muted-foreground" />
						)}
					</div>
				))}
			</div>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				{renderProgress()}
				{renderStepContent()}
			</DialogContent>
		</Dialog>
	);
}
