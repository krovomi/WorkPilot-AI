import {
	ChevronDown,
	ChevronRight,
	File,
	Folder,
	FolderOpen,
	Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Subtask } from "../../../shared/types";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "../ui/tooltip";

interface FileNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: FileNode[];
}

interface TaskCodeEditorProps {
	readonly subtask: Subtask;
	/** Saves the subtask; resolves false when the save was refused. */
	readonly onUpdate?: (subtask: Subtask) => Promise<boolean>;
}

function buildFileTree(files: string[]): FileNode[] {
	const root: FileNode[] = [];

	for (const filePath of files) {
		const parts = filePath.replaceAll("\\", "/").split("/");
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const name = parts[i];
			const isLast = i === parts.length - 1;
			const partPath = parts.slice(0, i + 1).join("/");

			if (isLast) {
				current.push({
					name,
					path: partPath,
					isFolder: false,
					children: [],
				});
			} else {
				let folder = current.find((n) => n.isFolder && n.name === name);
				if (!folder) {
					folder = {
						name,
						path: partPath,
						isFolder: true,
						children: [],
					};
					current.push(folder);
				}
				current = folder.children;
			}
		}
	}

	// Sort recursively
	function processNode(nodes: FileNode[]): void {
		for (const node of nodes) {
			if (node.isFolder) {
				processNode(node.children);
			}
		}
		nodes.sort((a, b) => {
			if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	processNode(root);
	return root;
}

function FileTreeNode({
	node,
	depth,
	onDelete,
}: {
	readonly node: FileNode;
	readonly depth: number;
	readonly onDelete?: (path: string) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const [expanded, setExpanded] = useState(false);

	if (node.isFolder) {
		return (
			<>
				<button
					type="button"
					aria-expanded={expanded}
					className="w-full flex items-center justify-between p-1.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer select-none text-left"
					style={{ paddingLeft: depth * 16 + 8 }}
					onClick={() => setExpanded(!expanded)}
				>
					<div className="flex items-center gap-1.5 min-w-0 flex-1">
						{expanded ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0" />
						)}
						{expanded ? (
							<FolderOpen className="h-4 w-4 shrink-0 text-warning" />
						) : (
							<Folder className="h-4 w-4 shrink-0 text-warning" />
						)}
						<span className="text-sm font-medium truncate">{node.name}</span>
					</div>
				</button>
				{expanded &&
					node.children.map((child) => (
						<FileTreeNode
							key={child.path}
							node={child}
							depth={depth + 1}
							onDelete={onDelete}
						/>
					))}
			</>
		);
	}

	return (
		<div
			className="flex items-center justify-between p-1.5 rounded-lg hover:bg-secondary/50 transition-colors select-none group"
			style={{ paddingLeft: depth * 16 + 8 }}
		>
			<span className="flex items-center gap-1.5 min-w-0 flex-1" title={node.path}>
				<File className="h-4 w-4 shrink-0 text-blue-400" />
				<span className="text-sm truncate">{node.name}</span>
			</span>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("tasks:codeEditor.removeFile", { name: node.path })}
						className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
						onClick={() => onDelete?.(node.path)}
					>
						<Trash2 className="h-3.5 w-3.5 text-destructive" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("tasks:codeEditor.removeFile", { name: node.path })}</TooltipContent>
			</Tooltip>
		</div>
	);
}

/**
 * The files a pending subtask is planned to touch, as a tree: a file that the
 * subtask should leave alone is removed from its plan. Nothing on disk changes;
 * the agent reads the trimmed list when it codes the subtask.
 */
export function TaskCodeEditor({
	subtask,
	onUpdate,
}: TaskCodeEditorProps) {
	const { t } = useTranslation(["tasks", "taskReview", "common"]);
	const [removedFiles, setRemovedFiles] = useState<Set<string>>(new Set());
	const [isSaving, setIsSaving] = useState(false);

	const keptFiles = subtask.files.filter((f) => !removedFiles.has(f));
	const fileTree = buildFileTree(keptFiles);

	const handleFileRemove = useCallback((path: string) => {
		setRemovedFiles((prev) => new Set(prev).add(path));
	}, []);

	const handleSave = async () => {
		if (!onUpdate) return;

		setIsSaving(true);
		try {
			// A refused save keeps the selection, so it can be tried again.
			if (await onUpdate({ ...subtask, files: keptFiles })) {
				setRemovedFiles(new Set());
			}
		} catch (error) {
			console.error("Failed to save changes:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
				{t("tasks:codeEditor.hint")}
			</p>
			<ScrollArea className="flex-1">
				<div className="p-2 space-y-1">
					{fileTree.length === 0 ? (
						<p className="text-xs text-muted-foreground p-2">
							{t("taskReview:taskPanel.noFilesInSubtask")}
						</p>
					) : (
						fileTree.map((node) => (
							<FileTreeNode
								key={node.path}
								node={node}
								depth={0}
								onDelete={handleFileRemove}
							/>
						))
					)}
				</div>
			</ScrollArea>

			{removedFiles.size > 0 && (
				<div className="p-3 border-t border-border bg-muted/30 flex items-center justify-between">
					<p className="text-xs text-muted-foreground">
						{t("tasks:codeEditor.filesRemoved", { count: removedFiles.size })}
					</p>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setRemovedFiles(new Set())}
							disabled={isSaving}
						>
							{t("common:buttons.cancel")}
						</Button>
						<Button
							variant="default"
							size="sm"
							onClick={handleSave}
							disabled={isSaving}
						>
							{isSaving ? t("common:buttons.saving") : t("taskReview:taskPanel.saveChanges")}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
