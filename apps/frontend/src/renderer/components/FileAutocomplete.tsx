import { ChevronRight, File } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileSearchResult } from "../../shared/types";
import { cn } from "../lib/utils";

interface FileAutocompleteProps {
	query: string;
	projectPath: string;
	position: { top: number; left: number };
	/** Receives the project-relative POSIX path — what goes after the `@`. */
	onSelect: (relativePath: string) => void;
	onClose: () => void;
	maxResults?: number;
}

const SEARCH_DEBOUNCE_MS = 120;

/**
 * Autocomplete popup for @ file mentions in the task description.
 *
 * The whole project is searched in the main process (`searchProjectFiles`,
 * the same walk the agent path inputs use). It used to flatten whatever the
 * file explorer happened to have cached — the root directory and nothing
 * else unless the user had expanded folders in the explorer drawer — so a
 * file one level down could not be mentioned at all.
 */
export function FileAutocomplete({
	query,
	projectPath,
	position,
	onSelect,
	onClose,
	maxResults = 10,
}: FileAutocompleteProps) {
	const { t } = useTranslation(["tasks"]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [results, setResults] = useState<FileSearchResult[]>([]);
	// The query `results` answers. While it differs from `query` a newer search
	// is on its way, and the keyboard must not pick from the previous list:
	// typing `@app` then Enter would otherwise insert a match for `@a`.
	const [answered, setAnswered] = useState<string | null>(null);
	const loading = answered !== query;
	const listRef = useRef<HTMLDivElement>(null);
	// Latest-wins: a slow search for "@a" must not overwrite the one for "@app".
	const requestSeq = useRef(0);

	useEffect(() => {
		const seq = ++requestSeq.current;
		const timer = setTimeout(async () => {
			try {
				const result = await window.electronAPI.searchProjectFiles(
					projectPath,
					query,
					"file",
				);
				if (seq !== requestSeq.current) return;
				setResults(
					result.success && result.data
						? result.data.slice(0, maxResults)
						: [],
				);
			} catch {
				if (seq === requestSeq.current) setResults([]);
			} finally {
				if (seq === requestSeq.current) {
					setAnswered(query);
					setSelectedIndex(0);
				}
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			// A search already in flight answers nobody once the query changed
			// or the popup closed.
			requestSeq.current++;
		};
	}, [projectPath, query, maxResults]);

	// Scroll selected item into view
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;

		const selectedElement = list.children[selectedIndex] as
			| HTMLElement
			| undefined;
		selectedElement?.scrollIntoView?.({ block: "nearest" });
	}, [selectedIndex]);

	// Handle keyboard navigation
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setSelectedIndex((prev) =>
						prev < results.length - 1 ? prev + 1 : prev,
					);
					break;
				case "ArrowUp":
					e.preventDefault();
					setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
					break;
				case "Enter":
				case "Tab": {
					const file = results[selectedIndex];
					if (!file) return;
					// Swallow the key rather than insert a match for an older query.
					e.preventDefault();
					if (!loading) onSelect(file.relativePath);
					break;
				}
				case "Escape":
					e.preventDefault();
					onClose();
					break;
			}
		},
		[results, selectedIndex, loading, onSelect, onClose],
	);

	// Attach keyboard listener
	useEffect(() => {
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	if (results.length === 0) {
		return (
			<div
				className="absolute z-50 bg-popover border border-border rounded-md shadow-lg p-3 text-sm text-muted-foreground"
				style={{
					top: position.top,
					left: position.left,
					minWidth: "200px",
				}}
				role="status"
			>
				{loading
					? t("tasks:fileAutocomplete.searching")
					: t("tasks:fileAutocomplete.empty")}
			</div>
		);
	}

	return (
		<div
			className="absolute z-50 bg-popover border border-border rounded-md shadow-lg overflow-hidden"
			style={{
				top: position.top,
				left: position.left,
				minWidth: "280px",
				maxWidth: "400px",
				maxHeight: "240px",
			}}
		>
			<div ref={listRef} className="overflow-y-auto max-h-[240px]">
				{results.map((file, index) => (
					<button
						type="button"
						key={file.relativePath}
						className={cn(
							"w-full flex items-center gap-2 px-3 py-2 text-left text-sm",
							"hover:bg-accent hover:text-accent-foreground",
							"focus:outline-none transition-colors",
							index === selectedIndex && "bg-accent text-accent-foreground",
						)}
						onClick={() => onSelect(file.relativePath)}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<File className="h-4 w-4 text-muted-foreground shrink-0" />
						<div className="flex-1 min-w-0">
							<div className="font-medium truncate">{file.name}</div>
							<div className="text-xs text-muted-foreground truncate flex items-center gap-1">
								<ChevronRight className="h-3 w-3 shrink-0" />
								{file.relativePath}
							</div>
						</div>
					</button>
				))}
			</div>
			<div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground bg-muted/30">
				{t("tasks:fileAutocomplete.hint")}
			</div>
		</div>
	);
}
