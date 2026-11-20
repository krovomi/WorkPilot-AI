import {
	ChevronDown,
	ChevronRight,
	File,
	FileCode,
	FileImage,
	FileJson,
	FileText,
	Folder,
	Loader2,
	type LucideIcon,
} from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { FileNode } from "../../shared/types";
import { cn } from "../lib/utils";

interface FileTreeItemProps {
	node: FileNode;
	depth: number;
	isExpanded: boolean;
	isLoading: boolean;
	onToggle: () => void;
	/** Clicking a folder also picks it (the save dialog of the canvas). */
	onSelectFolder?: (path: string) => void;
	selectedFolder?: string;
}

// The icon and colour of a file, by extension; anything else is a plain file.
const FILE_KINDS: ReadonlyArray<
	readonly [readonly string[], LucideIcon, string]
> = [
	[
		["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp"],
		FileCode,
		"text-info",
	],
	[["h", "cs", "php", "swift", "kt"], FileCode, "text-info"],
	[["json", "yaml", "yml", "toml"], FileJson, "text-warning"],
	[["md", "txt", "rst"], FileText, "text-muted-foreground"],
	[
		["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"],
		FileImage,
		"text-purple-400",
	],
	[["css", "scss", "sass", "less"], FileCode, "text-pink-400"],
	[["html", "htm"], FileCode, "text-orange-400"],
];

function getFileIcon(name: string): React.ReactNode {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	const [, Icon, colour] = FILE_KINDS.find(([exts]) => exts.includes(ext)) ?? [
		[],
		File,
		"text-muted-foreground",
	];
	return <Icon className={cn("h-4 w-4", colour)} />;
}

export function FileTreeItem({
	node,
	depth,
	isExpanded,
	isLoading,
	onToggle,
	onSelectFolder,
	selectedFolder,
}: FileTreeItemProps) {
	const { t } = useTranslation("common");
	const [isDragging, setIsDragging] = useState(false);
	const dragImageRef = useRef<HTMLDivElement | null>(null);

	// Cleanup drag image on unmount to prevent memory leaks
	// This handles cases where component unmounts mid-drag or dragend doesn't fire
	useEffect(() => {
		return () => {
			if (dragImageRef.current) {
				dragImageRef.current.remove();
				dragImageRef.current = null;
			}
		};
	}, []);

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (node.isDirectory) {
			onToggle();
			if (onSelectFolder) onSelectFolder(node.path);
		}
	};

	const handleDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (node.isDirectory) {
			onToggle();
		}
	};

	// Bound on folders only.
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			e.stopPropagation();
			onToggle();
		}
	};

	const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
		e.stopPropagation();
		setIsDragging(true);

		// Set the drag data as JSON
		const dragData = {
			type: "file-reference",
			path: node.path,
			name: node.name,
			isDirectory: node.isDirectory,
		};
		e.dataTransfer.setData("application/json", JSON.stringify(dragData));
		e.dataTransfer.setData("text/plain", `@${node.name}`);
		e.dataTransfer.effectAllowed = "copy";

		// Create a custom drag image using safe DOM manipulation (no innerHTML)
		const dragImage = document.createElement("div");
		dragImage.className =
			"flex items-center gap-2 bg-card border border-primary rounded-md px-3 py-2 shadow-lg text-sm";

		const iconSpan = document.createElement("span");
		iconSpan.textContent = node.isDirectory ? "📁" : "📄";

		const nameSpan = document.createElement("span");
		nameSpan.textContent = node.name;

		dragImage.appendChild(iconSpan);
		dragImage.appendChild(nameSpan);
		dragImage.style.position = "absolute";
		dragImage.style.top = "-1000px";
		dragImage.style.left = "-1000px";
		document.body.appendChild(dragImage);
		e.dataTransfer.setDragImage(dragImage, 0, 0);

		// Store reference for cleanup in dragend
		dragImageRef.current = dragImage;
	};

	const handleDragEnd = () => {
		setIsDragging(false);

		// Clean up drag image element
		if (dragImageRef.current) {
			dragImageRef.current.remove();
			dragImageRef.current = null;
		}
	};

	// The folder picked in a folder picker is highlighted.
	const isSelected = selectedFolder === node.path;

	// Determine which icon to show in the expand/collapse button
	const getExpandIcon = () => {
		if (isLoading) {
			return (
				<Loader2
					className="h-3 w-3 animate-spin text-muted-foreground"
					aria-hidden="true"
				/>
			);
		}
		if (isExpanded) {
			return (
				<ChevronDown
					className="h-3 w-3 text-muted-foreground"
					aria-hidden="true"
				/>
			);
		}
		return (
			<ChevronRight
				className="h-3 w-3 text-muted-foreground"
				aria-hidden="true"
			/>
		);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: interactive handler is intentional
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: Electron desktop app — draggable file tree item
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: ARIA attributes are valid for this role
		<div
			role={node.isDirectory ? "button" : undefined}
			tabIndex={node.isDirectory ? 0 : undefined}
			draggable
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onKeyDown={node.isDirectory ? handleKeyDown : undefined}
			className={cn(
				"flex items-center gap-1 py-1 px-2 rounded cursor-pointer select-none",
				"hover:bg-accent/50 transition-colors",
				node.isDirectory &&
					"focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
				isDragging && "opacity-50 bg-accent ring-2 ring-primary",
				isSelected && "bg-primary text-primary-foreground",
			)}
			style={{ paddingLeft: `${depth * 12 + 8}px` }}
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			aria-label={
				node.isDirectory
					? t("accessibility.toggleFolder", { name: node.name })
					: undefined
			}
			aria-expanded={node.isDirectory ? isExpanded : undefined}
			aria-pressed={node.isDirectory && onSelectFolder ? isSelected : undefined}
		>
			{/* Expand/collapse chevron for directories */}
			{node.isDirectory ? (
				<button
					type="button"
					className="flex items-center justify-center w-4 h-4 hover:bg-accent rounded"
					onClick={(e) => {
						e.stopPropagation();
						onToggle();
					}}
					aria-label={
						isExpanded
							? t("accessibility.collapseFolder", { name: node.name })
							: t("accessibility.expandFolder", { name: node.name })
					}
					aria-expanded={isExpanded}
					tabIndex={-1}
				>
					{getExpandIcon()}
				</button>
			) : (
				<span className="w-4" aria-hidden="true" />
			)}

			{/* Icon */}
			{node.isDirectory ? (
				<Folder
					className={cn(
						"h-4 w-4",
						isExpanded ? "text-primary" : "text-warning",
					)}
				/>
			) : (
				getFileIcon(node.name)
			)}

			{/* Name */}
			<span
				className={cn(
					"text-xs truncate flex-1",
					isSelected ? "text-primary-foreground" : "text-foreground",
				)}
			>
				{node.name}
			</span>
		</div>
	);
}
