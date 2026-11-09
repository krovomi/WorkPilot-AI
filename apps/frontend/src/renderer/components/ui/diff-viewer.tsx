import { ChevronsUpDown, FileText, MessageSquarePlus } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
	buildSplitRows,
	countChanges,
	type DiffLayout,
	type DiffLine,
	type DiffViewMode,
	pairChangedLines,
	parseDiff,
	patchFilePath,
	resolveDiffLayout,
} from "./diff-model";
import { splitLine } from "./diff-segments";
import { type SyntaxToken, useDiffSyntax } from "./diff-syntax";
import { diffWords, type TextRange } from "./diff-words";
import "./diff-viewer.css";

export {
	buildSplitRows,
	type DiffLayout,
	type DiffLine,
	type DiffViewMode,
	parseDiff,
};

interface DiffViewerProps {
	patch?: string;
	className?: string;
	/**
	 * "auto" (default) puts old and new side by side when a file has both
	 * removals and additions and the view is wide enough; "unified" shows one
	 * column; "split" shows old/new side by side. A new or deleted file is
	 * always one column (the other half would be empty).
	 */
	viewMode?: DiffViewMode;
	/** The file the patch is about, for syntax colours (else read from the patch). */
	filePath?: string;
	/**
	 * Shows a comment button in the gutter of every line: a removed line is
	 * commented on the old side, any other on the new side.
	 */
	onCommentLine?: (target: DiffLineTarget) => void;
}

/** A line of the diff a comment can be anchored on. */
export interface DiffLineTarget {
	side: "old" | "new";
	line: number;
}

const SIGN: Record<DiffLine["type"], string> = {
	added: "+",
	removed: "-",
	context: " ",
	hunk: " ",
};

const ROW_CLASS: Record<DiffLine["type"], string | undefined> = {
	added: "is-add",
	removed: "is-del",
	context: undefined,
	hunk: undefined,
};

interface LineDecor {
	syntax: Map<number, SyntaxToken[]> | null;
	words: Map<number, TextRange[]>;
	onCommentLine?: (target: DiffLineTarget) => void;
}

/** Changed words of every rewritten line (removed line paired with its added one). */
function buildWordMap(lines: DiffLine[]): Map<number, TextRange[]> {
	const words = new Map<number, TextRange[]>();
	for (const [removed, added] of pairChangedLines(lines)) {
		if (lines[removed].type !== "removed") continue;
		const diff = diffWords(lines[removed].content, lines[added].content);
		if (!diff) continue;
		words.set(removed, diff.removed);
		words.set(added, diff.added);
	}
	return words;
}

/** Width of the element, followed while `active` (for the "auto" layout). */
function useElementWidth(active: boolean) {
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState<number | undefined>(undefined);
	useEffect(() => {
		if (!active || !node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			setWidth(entries[0]?.contentRect.width);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [active, node]);
	return [setNode, width] as const;
}

export function DiffViewer({
	patch,
	className,
	viewMode = "auto",
	filePath,
	onCommentLine,
}: DiffViewerProps) {
	const { t } = useTranslation(["common"]);
	const lines = useMemo(() => (patch ? parseDiff(patch) : []), [patch]);
	const path = useMemo(
		() => filePath ?? (patch ? patchFilePath(patch) : undefined),
		[filePath, patch],
	);
	const syntax = useDiffSyntax(lines, path, patch?.length ?? 0);
	const words = useMemo(() => buildWordMap(lines), [lines]);
	const counts = useMemo(() => countChanges(lines), [lines]);
	const digits = useMemo(() => {
		let max = 0;
		for (const line of lines) {
			max = Math.max(max, line.oldLineNumber ?? 0, line.newLineNumber ?? 0);
		}
		return Math.max(2, String(max).length);
	}, [lines]);
	const [measure, width] = useElementWidth(viewMode === "auto");

	if (!patch || patch.trim() === "") {
		return (
			<div className={cn("p-4 text-center text-muted-foreground", className)}>
				<div className="flex flex-col items-center gap-2">
					<FileText className="h-8 w-8 opacity-50" />
					<span>{t("common:diffViewer.noContent")}</span>
					<span className="text-xs">
						{t("common:diffViewer.noContentHint")}
					</span>
				</div>
			</div>
		);
	}

	const layout = resolveDiffLayout(viewMode, counts, width);
	const decor: LineDecor = { syntax, words, onCommentLine };

	return (
		<div
			ref={measure}
			className={cn("dv diff-viewer", className)}
			data-layout={layout}
			style={{ "--dv-digits": `${digits}ch` } as CSSProperties}
		>
			{layout === "split" ? (
				<SplitDiff lines={lines} decor={decor} />
			) : (
				<UnifiedDiff lines={lines} decor={decor} />
			)}
		</div>
	);
}

function lineTarget(line: DiffLine): DiffLineTarget | null {
	if (line.type === "hunk") return null;
	if (line.type === "removed") {
		return line.oldLineNumber ? { side: "old", line: line.oldLineNumber } : null;
	}
	return line.newLineNumber ? { side: "new", line: line.newLineNumber } : null;
}

/** The hunk separator: unchanged lines skipped, `@@` range, enclosing scope. */
function HunkHeader({ line }: { line: DiffLine }) {
	const { t } = useTranslation(["common"]);
	return (
		<div className="dv-hunk" data-diff-hunk="true">
			{(line.hiddenBefore ?? 0) > 0 && (
				<span className="dv-hunk-gap">
					<ChevronsUpDown className="h-3 w-3" aria-hidden="true" />
					{t("common:diffViewer.hiddenLines", { count: line.hiddenBefore })}
				</span>
			)}
			<span className="dv-hunk-range">{line.range ?? line.content}</span>
			{line.section && (
				<span className="dv-hunk-section">{line.section}</span>
			)}
		</div>
	);
}

function CommentCell({
	line,
	onCommentLine,
}: {
	line: DiffLine;
	onCommentLine: (target: DiffLineTarget) => void;
}) {
	const { t } = useTranslation(["common"]);
	const target = lineTarget(line);
	return (
		<span className="dv-comment">
			{target && (
				<button
					type="button"
					onClick={() => onCommentLine(target)}
					aria-label={t("common:diffViewer.commentLine", { line: target.line })}
					title={t("common:diffViewer.commentLine", { line: target.line })}
				>
					<MessageSquarePlus className="h-3 w-3" />
				</button>
			)}
		</span>
	);
}

/** The code of a line: syntax colours, changed words marked on top. */
function CodeCell({
	line,
	index,
	decor,
}: {
	line: DiffLine;
	index: number;
	decor: LineDecor;
}) {
	const segments = splitLine(
		line.content,
		decor.syntax?.get(index),
		decor.words.get(index),
	);
	const wordClass = line.type === "removed" ? "dv-word-del" : "dv-word-add";
	return (
		<span className="dv-code">
			{segments.map((segment) => (
				<span
					key={segment.from}
					className={cn(segment.className, segment.changed && wordClass)}
				>
					{segment.text}
				</span>
			))}
		</span>
	);
}

/** Classic single-column diff: removed and added lines interleaved. */
function UnifiedDiff({
	lines,
	decor,
}: {
	lines: DiffLine[];
	decor: LineDecor;
}) {
	const items = useMemo(
		() => lines.map((line, index) => ({ line, index })),
		[lines],
	);
	return (
		<div className="diff-content">
			{items.map(({ line, index }) =>
				line.type === "hunk" ? (
					<HunkHeader key={index} line={line} />
				) : (
					<div
						key={index}
						className={cn("dv-row diff-line", ROW_CLASS[line.type])}
						data-line-type={line.type}
					>
						{decor.onCommentLine && (
							<CommentCell line={line} onCommentLine={decor.onCommentLine} />
						)}
						<span className="dv-num">{line.oldLineNumber ?? ""}</span>
						<span className="dv-num">{line.newLineNumber ?? ""}</span>
						<span className="dv-sign" aria-hidden="true">
							{SIGN[line.type]}
						</span>
						<CodeCell line={line} index={index} decor={decor} />
					</div>
				),
			)}
		</div>
	);
}

/** One half of a side-by-side row: old side (left) or new side (right). */
function SplitHalf({
	line,
	index,
	side,
	decor,
}: {
	line?: DiffLine;
	index?: number;
	side: "old" | "new";
	decor: LineDecor;
}) {
	if (!line || index === undefined) {
		return <div className="dv-half is-empty" data-side={side} />;
	}
	const number = side === "old" ? line.oldLineNumber : line.newLineNumber;
	return (
		<div
			className={cn("dv-half", ROW_CLASS[line.type])}
			data-side={side}
			data-line-type={line.type}
		>
			{decor.onCommentLine &&
				// A context row is commented once, on its new side.
				((side === "old") === (line.type === "removed") ? (
					<CommentCell line={line} onCommentLine={decor.onCommentLine} />
				) : (
					<span className="dv-comment" />
				))}
			<span className="dv-num">{number ?? ""}</span>
			<span className="dv-sign" aria-hidden="true">
				{SIGN[line.type]}
			</span>
			<CodeCell line={line} index={index} decor={decor} />
		</div>
	);
}

/** Side-by-side diff: old version (left) vs new version (right), GitHub-style. */
function SplitDiff({ lines, decor }: { lines: DiffLine[]; decor: LineDecor }) {
	const rows = useMemo(
		() =>
			buildSplitRows(lines).map((row, position) => ({ row, key: position })),
		[lines],
	);
	return (
		<div className="diff-content">
			{rows.map(({ row, key }) =>
				row.type === "hunk" && row.left ? (
					<HunkHeader key={key} line={row.left} />
				) : (
					<div key={key} className="dv-row diff-line">
						<SplitHalf
							line={row.left}
							index={row.leftIndex}
							side="old"
							decor={decor}
						/>
						<SplitHalf
							line={row.right}
							index={row.rightIndex}
							side="new"
							decor={decor}
						/>
					</div>
				),
			)}
		</div>
	);
}

export default DiffViewer;
