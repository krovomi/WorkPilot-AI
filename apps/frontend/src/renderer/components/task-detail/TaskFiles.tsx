import {
	AlertCircle,
	ChevronRight,
	ExternalLink,
	FileJson,
	FileText,
	FolderOpen,
	Loader2,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Task } from "../../../shared/types";
import type { FileNode } from "../../../shared/types/project";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings-store";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
	resolveTaskFiles,
	type TaskFileEntry,
	type TaskFileStatus,
	type TaskFilesResult,
} from "./task-files-model";

interface TaskFilesProps {
	task: Task;
	/** The task's project, to read files the task changed once merged. */
	projectPath?: string;
}

// Spec-folder file types to display (the task's own files are all shown).
const ALLOWED_SPEC_EXTENSIONS = [".md", ".json"];

/** One entry of the list: a file the task changed, or a spec-folder file. */
type Selection =
	| { kind: "task"; entry: TaskFileEntry }
	| { kind: "spec"; file: FileNode };

function selectionKey(selection: Selection): string {
	return selection.kind === "task"
		? `task:${selection.entry.path}`
		: `spec:${selection.file.path}`;
}

function selectionName(selection: Selection): string {
	return selection.kind === "task"
		? selection.entry.path
		: selection.file.name;
}

// Get icon for file type
function getFileIcon(filename: string) {
	if (filename.endsWith(".json")) {
		return <FileJson className="h-4 w-4 shrink-0 text-amber-500" />;
	}
	return <FileText className="h-4 w-4 shrink-0 text-blue-500" />;
}

const STATUS_STYLE: Record<TaskFileStatus, string> = {
	added: "text-emerald-500",
	modified: "text-amber-500",
	deleted: "text-destructive",
	renamed: "text-sky-500",
	unknown: "text-muted-foreground",
};

const STATUS_LETTER: Record<TaskFileStatus, string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	unknown: "•",
};

const EMPTY_TASK_FILES: TaskFilesResult = {
	files: [],
	root: null,
	source: "none",
	error: null,
};

export function TaskFiles({ task, projectPath }: TaskFilesProps) {
	const { t } = useTranslation(["tasks"]);
	const { settings } = useSettingsStore(
		useShallow((s) => ({ settings: s.settings })),
	);

	// Files the task created / modified / deleted
	const [taskFiles, setTaskFiles] = useState<TaskFilesResult>(EMPTY_TASK_FILES);
	// Files of the spec folder (spec.md, plan, JSON artifacts)
	const [specFiles, setSpecFiles] = useState<FileNode[]>([]);
	const [isLoadingFiles, setIsLoadingFiles] = useState(true);
	const [specError, setSpecError] = useState<string | null>(null);

	// State for file content
	const [selected, setSelected] = useState<Selection | null>(null);
	const [fileContent, setFileContent] = useState<string | null>(null);
	/** True when the content shown is the file's diff, not its text. */
	const [contentIsPatch, setContentIsPatch] = useState(false);
	const [isLoadingContent, setIsLoadingContent] = useState(false);
	const [contentError, setContentError] = useState<string | null>(null);

	// The subtasks' recorded files, by value: the task object is replaced on
	// every progress event, which must not reload the list each time.
	const subtaskFilesKey = JSON.stringify(
		(task.subtasks ?? []).map((s) => s.files ?? []),
	);
	const subtaskFiles = useMemo(
		() =>
			(JSON.parse(subtaskFilesKey) as string[][]).map((files) => ({ files })),
		[subtaskFilesKey],
	);

	const loadTaskFiles = useCallback(async (): Promise<TaskFilesResult> => {
		const api = window.electronAPI;
		let worktreePath: string | null = null;
		try {
			const status = await api.getWorktreeStatus(task.id);
			if (status.success && status.data?.exists) {
				worktreePath = status.data.worktreePath ?? null;
			}
		} catch {
			// No status: the diff below says whether the task has changes.
		}
		let diff: Parameters<typeof resolveTaskFiles>[0]["diff"];
		try {
			const result = await api.getWorktreeDiff(task.id);
			diff = {
				success: result.success,
				files: result.data?.files,
				error: result.error,
			};
		} catch (err) {
			diff = {
				success: false,
				error: err instanceof Error ? err.message : "Unknown error",
			};
		}
		return resolveTaskFiles({
			diff,
			worktreePath,
			projectPath: projectPath ?? null,
			subtasks: subtaskFiles,
		});
	}, [task.id, subtaskFiles, projectPath]);

	const loadSpecFiles = useCallback(async (): Promise<FileNode[]> => {
		if (!task.specsPath) return [];
		const result = await window.electronAPI.listDirectory(task.specsPath);
		if (!result.success || !result.data) {
			throw new Error(result.error || "Failed to load directory");
		}
		const filtered = result.data.filter(
			(file) =>
				!file.isDirectory &&
				ALLOWED_SPEC_EXTENSIONS.some((ext) => file.name.endsWith(ext)),
		);
		// spec.md first, then alphabetically
		filtered.sort((a, b) => {
			if (a.name === "spec.md") return -1;
			if (b.name === "spec.md") return 1;
			return a.name.localeCompare(b.name);
		});
		return filtered;
	}, [task.specsPath]);

	const loadFiles = useCallback(async () => {
		setIsLoadingFiles(true);
		setSpecError(null);
		const [taskResult, specResult] = await Promise.allSettled([
			loadTaskFiles(),
			loadSpecFiles(),
		]);
		setTaskFiles(
			taskResult.status === "fulfilled"
				? taskResult.value
				: {
						...EMPTY_TASK_FILES,
						error:
							taskResult.reason instanceof Error
								? taskResult.reason.message
								: "Unknown error",
					},
		);
		if (specResult.status === "fulfilled") {
			setSpecFiles(specResult.value);
		} else {
			setSpecFiles([]);
			setSpecError(
				specResult.reason instanceof Error
					? specResult.reason.message
					: "Unknown error",
			);
		}
		setIsLoadingFiles(false);
	}, [loadTaskFiles, loadSpecFiles]);

	// Every entry of the list, in display order (task files, then spec files)
	const entries = useMemo<Selection[]>(
		() => [
			...taskFiles.files.map(
				(entry): Selection => ({ kind: "task", entry }),
			),
			...specFiles.map((file): Selection => ({ kind: "spec", file })),
		],
		[taskFiles.files, specFiles],
	);

	// Load the selected file's content
	const loadContent = useCallback(
		async (selection: Selection) => {
			setSelected(selection);
			setIsLoadingContent(true);
			setContentError(null);
			setFileContent(null);
			setContentIsPatch(false);

			try {
				if (selection.kind === "spec") {
					const result = await window.electronAPI.readFile(
						selection.file.path,
					);
					if (!result.success || result.data === undefined) {
						throw new Error(result.error || "Failed to read file");
					}
					setFileContent(result.data);
					return;
				}

				const { entry } = selection;
				let readError: string | undefined;
				if (entry.status !== "deleted" && taskFiles.root) {
					const result = await window.electronAPI.worktreeReadFile(
						taskFiles.root,
						entry.path,
					);
					if (result.success && result.data !== undefined) {
						setFileContent(result.data);
						return;
					}
					readError = result.error;
				}
				// A deleted file, a binary, a server-mode task: the diff is what
				// can be shown.
				if (entry.patch) {
					setFileContent(entry.patch);
					setContentIsPatch(true);
					return;
				}
				throw new Error(readError || "Failed to read file");
			} catch (err) {
				setContentError(err instanceof Error ? err.message : "Unknown error");
			} finally {
				setIsLoadingContent(false);
			}
		},
		[taskFiles.root],
	);

	// Load files on mount and when the task's paths change
	useEffect(() => {
		void loadFiles();
	}, [loadFiles]);

	// Auto-select the first file (a file the task created, else spec.md)
	useEffect(() => {
		if (entries.length > 0 && selected === null) {
			void loadContent(entries[0]);
		}
	}, [entries, loadContent, selected]);

	const selectedKey = selected ? selectionKey(selected) : null;

	// The shown diff's lines, keyed by position (a patch is static text).
	const patchLines = useMemo(() => {
		if (!contentIsPatch || fileContent === null) return [];
		const lines: { key: string; line: string }[] = [];
		for (const line of fileContent.split("\n")) {
			lines.push({ key: `l${lines.length}`, line });
		}
		return lines;
	}, [contentIsPatch, fileContent]);

	// Open the selected file's folder in the IDE
	const handleOpenInIDE = useCallback(async () => {
		if (!settings.preferredIDE || !selected) return;
		const target =
			selected.kind === "task" ? taskFiles.root : (task.specsPath ?? null);
		if (!target) return;
		try {
			await window.electronAPI.worktreeOpenInIDE(target, settings.preferredIDE);
		} catch (err) {
			console.error("Failed to open in IDE:", err);
		}
	}, [settings.preferredIDE, selected, taskFiles.root, task.specsPath]);

	// Keyboard navigation for the file list
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (entries.length === 0) return;
			const currentIndex = selectedKey
				? entries.findIndex((entry) => selectionKey(entry) === selectedKey)
				: -1;
			let next: number | null = null;
			switch (e.key) {
				case "ArrowDown":
					if (currentIndex < entries.length - 1) next = currentIndex + 1;
					break;
				case "ArrowUp":
					if (currentIndex > 0) next = currentIndex - 1;
					break;
				case "Home":
					next = 0;
					break;
				case "End":
					next = entries.length - 1;
					break;
				default:
					return;
			}
			e.preventDefault();
			if (next !== null) void loadContent(entries[next]);
		},
		[entries, selectedKey, loadContent],
	);

	const renderEntry = (selection: Selection) => {
		const key = selectionKey(selection);
		const isSelected = key === selectedKey;
		const name =
			selection.kind === "task"
				? (selection.entry.path.split("/").pop() ?? selection.entry.path)
				: selection.file.name;
		const folder =
			selection.kind === "task" && selection.entry.path.includes("/")
				? selection.entry.path.slice(0, selection.entry.path.lastIndexOf("/"))
				: null;
		return (
			<button
				type="button"
				key={key}
				role="option"
				aria-selected={isSelected}
				title={selectionName(selection)}
				onClick={() => void loadContent(selection)}
				className={cn(
					"w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
					"hover:bg-secondary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
					isSelected && "bg-secondary",
				)}
			>
				{selection.kind === "task" ? (
					<span
						className={cn(
							"w-4 shrink-0 text-center font-mono text-3xs font-semibold",
							STATUS_STYLE[selection.entry.status],
						)}
						title={t(`tasks:files.status.${selection.entry.status}`)}
					>
						{STATUS_LETTER[selection.entry.status]}
					</span>
				) : (
					getFileIcon(name)
				)}
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"block truncate text-xs font-medium",
							selection.kind === "task" &&
								selection.entry.status === "deleted" &&
								"line-through text-muted-foreground",
						)}
					>
						{name}
					</span>
					{folder && (
						<span className="block truncate text-3xs text-muted-foreground">
							{folder}
						</span>
					)}
				</span>
				{isSelected && (
					<ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
				)}
			</button>
		);
	};

	// Render file content based on type
	const renderContent = () => {
		if (!selected) {
			return (
				<div className="h-full flex items-center justify-center text-muted-foreground">
					<div className="text-center">
						<FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
						<p className="text-sm">{t("tasks:files.selectFile")}</p>
					</div>
				</div>
			);
		}

		if (isLoadingContent) {
			return (
				<div className="h-full flex items-center justify-center">
					<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
				</div>
			);
		}

		if (contentError) {
			return (
				<div className="h-full flex items-center justify-center">
					<div className="text-center px-4">
						<AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
						<p className="text-sm text-destructive mb-1">
							{t("tasks:files.errorLoadingContent")}
						</p>
						<p className="text-xs text-muted-foreground mb-2 break-all">
							{contentError}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void loadContent(selected)}
						>
							<RefreshCw className="h-3 w-3 mr-1" />
							{t("tasks:files.retry")}
						</Button>
					</div>
				</div>
			);
		}

		if (fileContent === null) return null;

		if (contentIsPatch) {
			return (
				<pre className="text-xs font-mono whitespace-pre-wrap break-words p-4">
					{patchLines.map(({ key, line }) => (
						<span
							key={key}
							className={cn(
								"block",
								line.startsWith("+") && !line.startsWith("+++")
									? "text-emerald-500"
									: line.startsWith("-") && !line.startsWith("---")
										? "text-destructive"
										: "text-muted-foreground",
							)}
						>
							{line || " "}
						</span>
					))}
				</pre>
			);
		}

		// Render JSON with formatting
		if (selectionName(selected).endsWith(".json")) {
			try {
				const formatted = JSON.stringify(JSON.parse(fileContent), null, 2);
				return (
					<pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words p-4">
						{formatted}
					</pre>
				);
			} catch {
				// If JSON parsing fails, show raw content
			}
		}

		if (fileContent === "") {
			return (
				<p className="p-4 text-xs italic text-muted-foreground">
					{t("tasks:files.emptyFile")}
				</p>
			);
		}

		// Render text files
		return (
			<pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words p-4">
				{fileContent}
			</pre>
		);
	};

	const sectionTitle = (label: string, count: number) => (
		<div className="flex items-center justify-between px-2 pt-2 pb-1">
			<span className="text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			<span className="text-3xs text-muted-foreground">{count}</span>
		</div>
	);

	const nothingAtAll =
		!isLoadingFiles &&
		taskFiles.files.length === 0 &&
		specFiles.length === 0 &&
		!taskFiles.error &&
		!specError;

	if (nothingAtAll && !task.specsPath) {
		return (
			<div className="h-full flex items-center justify-center">
				<div className="text-center py-12">
					<FolderOpen className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
					<p className="text-sm font-medium text-muted-foreground mb-1">
						{t("tasks:files.noFiles")}
					</p>
				</div>
			</div>
		);
	}

	const selectedName = selected ? selectionName(selected) : null;

	return (
		<div className="h-full flex">
			{/* File list sidebar */}
			<div className="w-60 border-r border-border flex flex-col">
				{/* Sidebar header */}
				<div className="px-3 py-2 border-b border-border flex items-center justify-between">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						{t("tasks:files.title")}
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={() => void loadFiles()}
						disabled={isLoadingFiles}
						aria-label={t("tasks:files.refresh")}
					>
						<RefreshCw
							className={cn("h-3 w-3", isLoadingFiles && "animate-spin")}
						/>
					</Button>
				</div>
				<ScrollArea className="flex-1">
					{isLoadingFiles && entries.length === 0 ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
						</div>
					) : (
						<div
							className="p-2 space-y-1"
							role="listbox"
							aria-label={t("tasks:files.title")}
							tabIndex={entries.length > 0 ? 0 : -1}
							onKeyDown={handleKeyDown}
						>
							{/* Files the task created or changed */}
							{sectionTitle(
								t("tasks:files.taskChanges"),
								taskFiles.files.length,
							)}
							{taskFiles.source === "subtasks" && (
								<p className="px-2 pb-1 text-3xs text-muted-foreground">
									{t("tasks:files.fromSubtasks")}
								</p>
							)}
							{taskFiles.error ? (
								<div className="px-2 py-2">
									<p className="flex items-start gap-1 text-2xs text-destructive">
										<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
										<span>
											{t("tasks:files.errorLoadingChanges")}
											<span className="block break-all text-muted-foreground">
												{taskFiles.error}
											</span>
										</span>
									</p>
								</div>
							) : taskFiles.files.length === 0 ? (
								<p className="px-2 py-2 text-2xs text-muted-foreground">
									{t("tasks:files.noTaskChanges")}
								</p>
							) : (
								taskFiles.files.map((entry) =>
									renderEntry({ kind: "task", entry }),
								)
							)}

							{/* Spec folder */}
							{task.specsPath && (
								<>
									{sectionTitle(t("tasks:files.specSection"), specFiles.length)}
									{specError ? (
										<div className="px-2 py-2">
											<p className="text-2xs text-destructive mb-2">
												{t("tasks:files.errorLoading")}
											</p>
											<Button
												variant="outline"
												size="sm"
												onClick={() => void loadFiles()}
												className="text-xs"
											>
												<RefreshCw className="h-3 w-3 mr-1" />
												{t("tasks:files.retry")}
											</Button>
										</div>
									) : specFiles.length === 0 ? (
										<p className="px-2 py-2 text-2xs text-muted-foreground">
											{t("tasks:files.noFiles")}
										</p>
									) : (
										specFiles.map((file) => renderEntry({ kind: "spec", file }))
									)}
								</>
							)}
						</div>
					)}
				</ScrollArea>
			</div>

			{/* File content area */}
			<div className="flex-1 min-w-0 flex flex-col">
				{/* Content header */}
				{selectedName && selected && (
					<div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0 bg-muted/30">
						{getFileIcon(selectedName)}
						<span className="text-sm font-medium flex-1 truncate">
							{selectedName}
						</span>
						{selected.kind === "task" && (
							<span
								className={cn(
									"text-xs",
									STATUS_STYLE[selected.entry.status],
								)}
							>
								{t(`tasks:files.status.${selected.entry.status}`)}
							</span>
						)}
						{settings.preferredIDE && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-7 w-7"
										onClick={handleOpenInIDE}
										aria-label={t("tasks:files.openInIDE")}
									>
										<ExternalLink className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("tasks:files.openInIDE")}</TooltipContent>
							</Tooltip>
						)}
					</div>
				)}
				<ScrollArea className="flex-1">{renderContent()}</ScrollArea>
			</div>
		</div>
	);
}
