import {
	AlertTriangle,
	Check,
	Copy,
	ExternalLink,
	FolderSearch,
	GitBranch,
	Loader2,
	Pencil,
	RefreshCw,
	TerminalSquare,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Project,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import { cn } from "../../lib/utils";
import { renameProject, useProjectStore } from "../../stores/project-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface RepositorySectionProps {
	readonly project: Project;
	readonly settings: ProjectSettingsType;
	readonly setSettings?: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
}

/**
 * Where this project actually lives on disk, and the repository facts that go
 * with it. Rendered before the WorkPilot AI integration block and *outside* its
 * initialization gate: the checkout path is what someone opening a project's
 * settings looks for first, and it is knowable — and worth re-pointing — long
 * before `.workpilot/` exists.
 *
 * Every row here is now an input rather than a readout. The two that were
 * read-only were the two people came here to change: a checkout with no remote
 * could only be given one by leaving for a terminal, and the main branch was
 * reachable only from the GitHub or GitLab pane — which a project using neither
 * never opens. What each row writes to differs, and that difference is the
 * reason the save buttons are per-row rather than one at the bottom:
 *
 * | Row            | Written to                                    |
 * |----------------|-----------------------------------------------|
 * | name           | the project store, at once                    |
 * | current branch | the checkout (`git checkout`), at once        |
 * | remote         | the checkout (`git remote`), at once          |
 * | main branch    | `settings.mainBranch`, with the dialog's Save |
 *
 * A git command cannot be staged behind a dialog's Save button — it either ran
 * or it did not — so pretending otherwise would be the one thing worse than two
 * kinds of save: a Cancel that silently keeps a branch switch.
 */
export function RepositorySection({
	project,
	settings,
	setSettings,
}: RepositorySectionProps) {
	const { t } = useTranslation(["settings", "common"]);
	const missingPaths = useProjectStore((state) => state.missingPaths);
	const repathProject = useProjectStore((state) => state.repathProject);
	const isMissing = missingPaths.has(project.id);
	const git = useGitFacts(project.path, isMissing);

	const handleRepath = async () => {
		try {
			const newPath = await globalThis.electronAPI?.selectDirectory?.();
			if (!newPath) return;
			await repathProject(project.id, newPath);
		} catch (err) {
			console.error("[RepositorySection] repath failed:", err);
		}
	};

	const handleOpenTerminal = async () => {
		try {
			await globalThis.electronAPI?.openTerminal?.(project.path);
		} catch (err) {
			console.error("[RepositorySection] open terminal failed:", err);
		}
	};

	return (
		<section className="space-y-4">
			<h3 className="text-sm font-semibold text-foreground">
				{t("projectSections.repository.title")}
			</h3>

			<div className="rounded-lg border border-border bg-muted/30 divide-y divide-border">
				<Row label={t("projectSections.repository.name")}>
					<NameField project={project} />
				</Row>

				<Row label={t("projectSections.repository.path")}>
					<div className="space-y-2">
						<PathValue value={project.path} invalid={isMissing} />
						<div className="flex flex-wrap items-center gap-1">
							<CopyButton
								value={project.path}
								label={t("projectSections.repository.copyPath")}
							/>
							<Tooltip delayDuration={200}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 gap-1.5 px-2 text-xs"
										onClick={handleOpenTerminal}
										disabled={isMissing}
									>
										<TerminalSquare className="h-3.5 w-3.5" />
										{t("projectSections.repository.openTerminal")}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{t("projectSections.repository.openTerminalHint")}
								</TooltipContent>
							</Tooltip>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1.5 px-2 text-xs"
								onClick={handleRepath}
							>
								<FolderSearch className="h-3.5 w-3.5" />
								{t("projectSections.repository.changeFolder")}
							</Button>
						</div>
						{isMissing && (
							<p className="flex items-start gap-1.5 text-xs text-destructive">
								<AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden />
								{t("common:projectTab.missingPathDescription")}
							</p>
						)}
					</div>
				</Row>

				<Row label={t("projectSections.repository.workpilotPath")}>
					{project.autoBuildPath ? (
						<div className="space-y-2">
							<PathValue value={project.autoBuildPath} />
							<CopyButton
								value={project.autoBuildPath}
								label={t("projectSections.repository.copyPath")}
							/>
						</div>
					) : (
						<span className="text-sm text-muted-foreground">
							{t("projectSections.repository.workpilotPathMissing")}
						</span>
					)}
				</Row>

				<Row label={t("projectSections.repository.currentBranch")}>
					<CurrentBranchField
						projectPath={project.path}
						git={git}
						disabled={isMissing}
					/>
				</Row>

				<Row label={t("projectSections.repository.remote")}>
					<RemoteField
						projectPath={project.path}
						git={git}
						disabled={isMissing}
					/>
				</Row>

				<Row label={t("projectSections.repository.mainBranch")}>
					<MainBranchField
						projectPath={project.path}
						settings={settings}
						setSettings={setSettings}
						branches={git.branches}
						disabled={isMissing}
					/>
				</Row>
			</div>
		</section>
	);
}

function Row({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5 p-3 sm:flex-row sm:items-start sm:gap-4">
			<span className="text-xs font-medium text-muted-foreground sm:w-40 sm:shrink-0 sm:pt-1">
				{label}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

/**
 * The project's display name. Renaming touches nothing on disk, so it is
 * committed on its own rather than with the dialog — but behind an explicit
 * edit toggle, because a name is the one field here nobody opens this pane to
 * change by accident.
 */
function NameField({ project }: { readonly project: Project }) {
	const { t } = useTranslation("settings");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(project.name);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A rename landing from elsewhere (the tab bar) must not be masked by a
	// stale draft this pane never submitted.
	useEffect(() => {
		if (!editing) setDraft(project.name);
	}, [project.name, editing]);

	const commit = async () => {
		const trimmed = draft.trim();
		if (!trimmed || trimmed === project.name) {
			setEditing(false);
			setDraft(project.name);
			return;
		}
		setSaving(true);
		setError(null);
		const ok = await renameProject(project.id, trimmed);
		setSaving(false);
		if (ok) {
			setEditing(false);
		} else {
			setError(t("projectSections.repository.renameFailed"));
		}
	};

	if (!editing) {
		return (
			<div className="flex items-center gap-1">
				<span className="text-sm text-foreground">{project.name}</span>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 px-2 text-xs"
					onClick={() => setEditing(true)}
				>
					<Pencil className="h-3.5 w-3.5" />
					{t("projectSections.repository.rename")}
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void commit();
						if (e.key === "Escape") {
							setEditing(false);
							setDraft(project.name);
						}
					}}
					aria-label={t("projectSections.repository.name")}
					className="h-8 max-w-xs text-sm"
				/>
				<Button size="sm" className="h-8 px-2 text-xs" onClick={() => void commit()} disabled={saving}>
					{saving ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Check className="h-3.5 w-3.5" />
					)}
					{t("projectSections.repository.save")}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 px-2 text-xs"
					onClick={() => {
						setEditing(false);
						setDraft(project.name);
						setError(null);
					}}
				>
					<X className="h-3.5 w-3.5" />
					{t("projectSections.repository.cancel")}
				</Button>
			</div>
			<FieldError message={error} />
		</div>
	);
}

/**
 * Which branch the checkout is on, and the means to leave it. Typing a name
 * nothing knows creates it from HEAD, the way `git checkout -b` would; picking
 * a remote-tracking name checks out the branch it tracks rather than detaching.
 */
function CurrentBranchField({
	projectPath,
	git,
	disabled,
}: {
	readonly projectPath: string;
	readonly git: GitFacts;
	readonly disabled: boolean;
}) {
	const { t } = useTranslation("settings");
	const listId = useId();
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const current = git.currentBranch;
	useEffect(() => {
		setDraft(current ?? "");
	}, [current]);

	const commit = async () => {
		const target = draft.trim();
		if (!target || target === current) return;
		setBusy(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI?.checkoutGitBranch?.(
				projectPath,
				target,
			);
			if (result?.success) {
				await git.refresh();
			} else {
				setError(
					result?.error || t("projectSections.repository.branchSwitchFailed"),
				);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (git.loading && !current) {
		return <InlineSpinner />;
	}

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Input
					value={draft}
					list={listId}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void commit();
					}}
					disabled={disabled || busy}
					placeholder={t("projectSections.repository.currentBranchPlaceholder")}
					aria-label={t("projectSections.repository.currentBranch")}
					className="h-8 max-w-xs font-mono text-xs"
				/>
				<datalist id={listId}>
					{git.branches.map((branch) => (
						<option key={branch} value={branch} />
					))}
				</datalist>
				<Button
					size="sm"
					className="h-8 gap-1.5 px-2 text-xs"
					onClick={() => void commit()}
					disabled={disabled || busy || !draft.trim() || draft.trim() === current}
				>
					{busy ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<GitBranch className="h-3.5 w-3.5" />
					)}
					{t("projectSections.repository.switchBranch")}
				</Button>
			</div>
			{!current && !git.loading && (
				<p className="text-xs text-muted-foreground">
					{t("projectSections.repository.currentBranchUnknown")}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				{t("projectSections.repository.currentBranchHint")}
			</p>
			<FieldError message={error} />
		</div>
	);
}

/**
 * Where the checkout pushes. Two inputs rather than one, because `origin` is a
 * default and not a law — a fork workflow has two remotes and the interesting
 * one is rarely the first git happens to list.
 */
function RemoteField({
	projectPath,
	git,
	disabled,
}: {
	readonly projectPath: string;
	readonly git: GitFacts;
	readonly disabled: boolean;
}) {
	const { t } = useTranslation("settings");
	const [name, setName] = useState("origin");
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	const remoteUrl = git.remoteUrl;
	const remoteName = git.remoteName;
	useEffect(() => {
		setUrl(remoteUrl ?? "");
		setName(remoteName || "origin");
	}, [remoteUrl, remoteName]);

	const commit = async () => {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const result = await globalThis.electronAPI?.setGitRemote?.(
				projectPath,
				name.trim() || "origin",
				url.trim(),
				remoteName ?? undefined,
			);
			if (result?.success) {
				setSaved(true);
				setTimeout(() => setSaved(false), 2000);
				await git.refresh();
			} else {
				setError(
					result?.error || t("projectSections.repository.remoteSaveFailed"),
				);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (git.loading && !remoteUrl) {
		return <InlineSpinner />;
	}

	const dirty = url.trim() !== (remoteUrl ?? "") || name.trim() !== (remoteName || "origin");

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					disabled={disabled || busy}
					placeholder="origin"
					aria-label={t("projectSections.repository.remoteName")}
					className="h-8 w-28 font-mono text-xs"
				/>
				<Input
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void commit();
					}}
					disabled={disabled || busy}
					placeholder={t("projectSections.repository.remoteUrlPlaceholder")}
					aria-label={t("projectSections.repository.remoteUrl")}
					className="h-8 min-w-0 flex-1 font-mono text-xs"
				/>
			</div>
			<div className="flex flex-wrap items-center gap-1">
				<Button
					size="sm"
					className="h-7 gap-1.5 px-2 text-xs"
					onClick={() => void commit()}
					disabled={disabled || busy || !dirty}
				>
					{busy ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Check className="h-3.5 w-3.5" />
					)}
					{t("projectSections.repository.save")}
				</Button>
				{remoteUrl && (
					<CopyButton
						value={remoteUrl}
						label={t("projectSections.repository.copyPath")}
					/>
				)}
				{isWebUrl(remoteUrl) && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 px-2 text-xs"
						onClick={() => {
							void globalThis.electronAPI?.openExternal?.(remoteUrl as string);
						}}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						{t("projectSections.repository.openRemote")}
					</Button>
				)}
				{saved && (
					<span className="text-xs text-success">
						{t("projectSections.repository.saved")}
					</span>
				)}
			</div>
			{!remoteUrl && !git.loading && (
				<p className="text-xs text-muted-foreground">
					{t("projectSections.repository.remoteNone")}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				{t("projectSections.repository.remoteHint")}
			</p>
			<FieldError message={error} />
		</div>
	);
}

/**
 * The branch tasks branch *from*. Unlike the two rows above it this writes to
 * the project's settings, so it is saved by the dialog — and says so, because a
 * field that looks like its neighbours and commits at a different moment is
 * how a value gets typed, seen, and lost on Cancel.
 */
function MainBranchField({
	projectPath,
	settings,
	setSettings,
	branches,
	disabled,
}: {
	readonly projectPath: string;
	readonly settings: ProjectSettingsType;
	readonly setSettings?: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
	readonly branches: readonly string[];
	readonly disabled: boolean;
}) {
	const { t } = useTranslation("settings");
	const listId = useId();
	const [detecting, setDetecting] = useState(false);

	// No setter means this pane is rendered read-only by its host; report the
	// value rather than offering an input that goes nowhere.
	if (!setSettings) {
		return settings.mainBranch ? (
			<code className="text-xs bg-background px-2 py-1 rounded border border-border">
				{settings.mainBranch}
			</code>
		) : (
			<span className="text-sm text-muted-foreground">
				{t("projectSections.repository.mainBranchAuto")}
			</span>
		);
	}

	const detect = async () => {
		setDetecting(true);
		try {
			const result =
				await globalThis.electronAPI?.detectMainBranch?.(projectPath);
			if (result?.success && result.data) {
				setSettings((prev) => ({ ...prev, mainBranch: result.data as string }));
			}
		} catch (err) {
			console.error("[RepositorySection] main branch detection failed:", err);
		} finally {
			setDetecting(false);
		}
	};

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-1.5">
				<Input
					value={settings.mainBranch ?? ""}
					list={listId}
					onChange={(e) => {
						// Read the value now, not inside the updater: the updater runs
						// after React has re-rendered this controlled input, by which
						// point `e.target.value` is whatever the prop says again.
						const next = e.target.value;
						setSettings((prev) => ({
							...prev,
							// An emptied field means "go back to auto-detection", which is
							// the absence of the key and not an empty string — every reader
							// of `mainBranch` falls back only on a falsy value.
							mainBranch: next.trim() ? next : undefined,
						}));
					}}
					disabled={disabled}
					placeholder={t("projectSections.repository.mainBranchPlaceholder")}
					aria-label={t("projectSections.repository.mainBranch")}
					className="h-8 max-w-xs font-mono text-xs"
				/>
				<datalist id={listId}>
					{branches.map((branch) => (
						<option key={branch} value={branch} />
					))}
				</datalist>
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1.5 px-2 text-xs"
					onClick={() => void detect()}
					disabled={disabled || detecting}
				>
					{detecting ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<RefreshCw className="h-3.5 w-3.5" />
					)}
					{t("projectSections.repository.mainBranchDetect")}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				{settings.mainBranch
					? t("projectSections.repository.mainBranchHint")
					: t("projectSections.repository.mainBranchAuto")}
			</p>
		</div>
	);
}

function FieldError({ message }: { readonly message: string | null }) {
	if (!message) return null;
	return (
		<p className="flex items-start gap-1.5 text-xs text-destructive">
			<AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" aria-hidden />
			<span className="whitespace-pre-wrap break-words">{message}</span>
		</p>
	);
}

function InlineSpinner() {
	return (
		<span className="flex items-center gap-1.5 text-sm text-muted-foreground">
			<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
		</span>
	);
}

function PathValue({
	value,
	invalid = false,
}: {
	readonly value: string;
	readonly invalid?: boolean;
}) {
	return (
		<code
			className={cn(
				"block text-xs bg-background px-2 py-1.5 rounded border border-border",
				"break-all font-mono",
				invalid && "border-destructive/50 text-destructive",
			)}
		>
			{value}
		</code>
	);
}

function CopyButton({
	value,
	label,
}: {
	readonly value: string;
	readonly label: string;
}) {
	const { t } = useTranslation("settings");
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch (err) {
			// Clipboard access can be denied; leave the button silent rather than
			// claiming a copy that did not happen.
			console.error("[RepositorySection] copy failed:", err);
		}
	};

	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1.5 px-2 text-xs"
			onClick={handleCopy}
			aria-label={label}
		>
			{copied ? (
				<>
					<Check className="h-3.5 w-3.5 text-success" />
					{t("projectSections.repository.copied")}
				</>
			) : (
				<>
					<Copy className="h-3.5 w-3.5" />
					{label}
				</>
			)}
		</Button>
	);
}

interface GitFacts {
	readonly currentBranch: string | null;
	readonly remoteUrl: string | null;
	readonly remoteName: string | null;
	readonly branches: readonly string[];
	readonly loading: boolean;
	readonly refresh: () => Promise<void>;
}

/**
 * What only git can answer: which branch the checkout is on right now, where it
 * pushes, and what else it could be switched to. Read once per path — a settings
 * pane is not a git client, and polling would be noise — but re-read on demand,
 * because the rows above now *change* these and a stale readout after a
 * successful switch is worse than no readout.
 *
 * The branch list is the one call here that may touch the network (`git fetch`
 * runs inside it), so a failure leaves the others standing: an offline machine
 * still gets its current branch and its remote.
 */
function useGitFacts(projectPath: string, skip: boolean): GitFacts {
	const [currentBranch, setCurrentBranch] = useState<string | null>(null);
	const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
	const [remoteName, setRemoteName] = useState<string | null>(null);
	const [branches, setBranches] = useState<readonly string[]>([]);
	const [loading, setLoading] = useState(false);

	// Every read takes a ticket, and only the newest ticket may write. Three
	// calls are in flight at once here and the branch list runs `git fetch`
	// inside it, so a read started before a repath can land well after the one
	// started by it — and would then describe a repository that is no longer on
	// screen. A refresh after a successful switch is the same race at a shorter
	// distance.
	const readId = useRef(0);

	const read = useCallback(async () => {
		const ticket = ++readId.current;
		const isCurrent = () => readId.current === ticket;

		const clear = () => {
			setCurrentBranch(null);
			setRemoteUrl(null);
			setRemoteName(null);
			setBranches([]);
		};

		if (skip || !projectPath) {
			clear();
			return;
		}
		setLoading(true);
		try {
			const [branch, provider, branchList] = await Promise.all([
				globalThis.electronAPI?.getCurrentGitBranch?.(projectPath),
				globalThis.electronAPI?.detectRepoProvider?.(projectPath),
				globalThis.electronAPI?.getGitBranchesWithInfo?.(projectPath),
			]);
			if (!isCurrent()) return;
			setCurrentBranch(branch?.success ? (branch.data ?? null) : null);
			setRemoteUrl(
				provider?.success ? (provider.data?.remoteUrl ?? null) : null,
			);
			setRemoteName(
				provider?.success ? (provider.data?.remoteName ?? null) : null,
			);
			setBranches(
				branchList?.success && branchList.data
					? branchList.data.map((b) => b.name)
					: [],
			);
		} catch (err) {
			// A folder that is not a repository is an ordinary answer here, not
			// an error to surface: the rows fall back to their empty state.
			console.error("[RepositorySection] git lookup failed:", err);
			if (isCurrent()) clear();
		} finally {
			if (isCurrent()) setLoading(false);
		}
	}, [projectPath, skip]);

	useEffect(() => {
		void read();
	}, [read]);

	return {
		currentBranch,
		remoteUrl,
		remoteName,
		branches,
		loading,
		refresh: read,
	};
}

/** Only an http(s) remote can be handed to a browser; an SSH one is copied. */
function isWebUrl(url: string | null): boolean {
	return !!url && /^https?:\/\//i.test(url);
}
