import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizedTree } from "../hooks/useVirtualizedTree";
import { useFileExplorerStore } from "../stores/file-explorer-store";
import { FileTreeItem } from "./FileTreeItem";

interface FileTreeProps {
	rootPath: string;
	/** Picking a folder (the save dialog of the canvas); also offers its parent. */
	onSelectFolder?: (path: string) => void;
	selectedFolder?: string;
}

// Estimated height of each tree item in pixels
const ITEM_HEIGHT = 28;
// Number of items to render outside the visible area for smoother scrolling
const OVERSCAN = 10;

/**
 * The folder above `path`, written with the separator `path` uses, or `null`
 * at a root (`/`, `C:\`). Both separators are read: the tree shows the paths
 * the main process lists, on every OS.
 */
export function parentFolder(path: string): string | null {
	const trimmed = path.replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut < 0) return null;
	if (cut === 0) return trimmed.charAt(0);
	const parent = trimmed.slice(0, cut);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed.charAt(cut)}` : parent;
}

export function FileTree({
	rootPath,
	onSelectFolder,
	selectedFolder,
}: FileTreeProps) {
	const { t } = useTranslation();
	const parentRef = useRef<HTMLDivElement>(null);

	const loadDirectory = useFileExplorerStore((s) => s.loadDirectory);
	const error = useFileExplorerStore((s) => s.error);

	const { flattenedNodes, count, handleToggle, isRootLoading, hasRootFiles } =
		useVirtualizedTree(rootPath);

	// Load the root once per path (and again after a refresh empties the
	// cache). A failed load is not retried here: that would ask again forever.
	useEffect(() => {
		if (
			!hasRootFiles &&
			!useFileExplorerStore.getState().isLoadingDir(rootPath)
		) {
			loadDirectory(rootPath);
		}
	}, [rootPath, hasRootFiles, loadDirectory]);

	// Set up the virtualizer
	const rowVirtualizer = useVirtualizer({
		count,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ITEM_HEIGHT,
		overscan: OVERSCAN,
	});

	// Create toggle handler for each item
	const createToggleHandler = useCallback(
		(index: number) => {
			return () => {
				handleToggle(flattenedNodes[index].node);
			};
		},
		[flattenedNodes, handleToggle],
	);

	const renderBody = () => {
		if (isRootLoading && !hasRootFiles) {
			return (
				<div className="flex items-center justify-center py-8">
					<Loader2
						className="h-5 w-5 animate-spin text-muted-foreground"
						aria-label={t("common:labels.loading")}
					/>
				</div>
			);
		}

		if (error && !hasRootFiles) {
			return (
				<div
					role="alert"
					className="flex flex-col items-center justify-center py-8 px-4 text-center"
				>
					<AlertCircle className="h-5 w-5 text-destructive mb-2" />
					<p className="text-xs font-medium text-destructive">
						{t("common:fileExplorer.loadFailed")}
					</p>
					<p className="text-xs text-destructive">{error}</p>
				</div>
			);
		}

		if (count === 0) {
			return (
				<div className="flex flex-col items-center justify-center py-8 px-4 text-center">
					<FolderOpen className="h-6 w-6 text-muted-foreground mb-2" />
					<p className="text-xs text-muted-foreground">
						{t("common:fileExplorer.noFolders")}
						<br />
						{t("common:fileExplorer.checkPath")}
						<br />
						{t("common:fileExplorer.currentRoot", { path: rootPath })}
					</p>
				</div>
			);
		}

		return (
			<div
				ref={parentRef}
				className="h-full overflow-auto py-1"
				style={{ maxHeight: "100vh", overflowY: "auto" }}
			>
				{/* A folder that failed to open says so without hiding the tree. */}
				{error ? (
					<p role="alert" className="px-2 py-1 text-xs text-destructive">
						{t("common:fileExplorer.loadFailed")} {error}
					</p>
				) : null}
				{/* The large inner element to hold all of the items */}
				<div
					style={{
						height: `${rowVirtualizer.getTotalSize()}px`,
						width: "100%",
						position: "relative",
					}}
				>
					{/* Only the visible items in the virtualizer */}
					{rowVirtualizer.getVirtualItems().map((virtualItem) => {
						const item = flattenedNodes[virtualItem.index];
						return (
							<div
								key={item.key}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: `${virtualItem.size}px`,
									transform: `translateY(${virtualItem.start}px)`,
								}}
							>
								<FileTreeItem
									node={item.node}
									depth={item.depth}
									isExpanded={item.isExpanded}
									isLoading={item.isLoading}
									onToggle={createToggleHandler(virtualItem.index)}
									onSelectFolder={onSelectFolder}
									selectedFolder={selectedFolder}
								/>
							</div>
						);
					})}
				</div>
			</div>
		);
	};

	// Picking a folder can also go one level up, to a folder the tree does not show.
	const parent = onSelectFolder ? parentFolder(rootPath) : null;
	if (!onSelectFolder || parent === null) return renderBody();

	return (
		<div className="flex h-full flex-col">
			<button
				type="button"
				className="mb-2 self-start px-2 py-1 border rounded bg-muted"
				onClick={() => onSelectFolder(parent)}
			>
				{t("common:fileExplorer.parent")}
			</button>
			<div className="min-h-0 flex-1">{renderBody()}</div>
		</div>
	);
}
