import {
	AlertTriangle,
	Brain,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	FileCode,
	FileText,
	FolderSearch,
	Hourglass,
	Info,
	Pencil,
	Ruler,
	Search,
	Terminal,
	Wrench,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskLogEntry } from "../../../shared/types";
import {
	entryMatches,
	type LogMatcher,
} from "../../../shared/utils/task-logs-search";
import { formatAppDateTime } from "@/lib/date-format";
import { cn } from "../../lib/utils";
import { Badge } from "../ui";
import { translateLogMessage } from "./translateLogMessage";

/**
 * Render `text`, wrapping every hit of the search in a <mark> so it stands
 * out. Falls back to the raw text when there is no search or no hit, so
 * non-searching renders stay allocation-free.
 */
function HighlightedText({
	text,
	matcher,
}: {
	text: string;
	matcher: LogMatcher | null;
}): React.ReactNode {
	if (!matcher || !text) return text;
	const ranges = matcher.ranges(text);
	if (ranges.length === 0) return text;

	const parts: React.ReactNode[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start > cursor) parts.push(text.slice(cursor, start));
		parts.push(
			<mark
				key={start}
				className="rounded-[2px] bg-warning/50 text-foreground dark:bg-warning/30"
			>
				{text.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

// Log Entry Component
interface LogEntryProps {
	entry: TaskLogEntry;
	/** Active text search, for match highlighting (null = none). */
	matcher?: LogMatcher | null;
}

export function LogEntry({ entry, matcher = null }: LogEntryProps) {
	const { t } = useTranslation(["tasks"]);
	const [isExpanded, setIsExpanded] = useState(false);
	const hasDetail = Boolean(entry.detail);

	// A hit that lives only in the collapsed output would be invisible: open it.
	const hitOnlyInDetail = useMemo(() => {
		if (!matcher || !entry.detail || !matcher.test(entry.detail)) return false;
		return !entryMatches({ ...entry, detail: undefined }, matcher);
	}, [matcher, entry]);
	useEffect(() => {
		if (hitOnlyInDetail) setIsExpanded(true);
	}, [hitOnlyInDetail]);

	// Pre-built highlighted nodes for the searchable fields, reused across the
	// per-type render branches below. Known backend status lines (QA verdicts,
	// hot-swap, context switch…) are emitted in stable English and localised here
	// for display; anything else is shown as-is.
	const translatedContent = translateLogMessage(t, entry.content);
	const marker = /^(⏳|🧠|⚠️?|📊|📐)\s*/u.exec(translatedContent);
	const StatusIcon =
		marker?.[1] === "⏳"
			? Hourglass
			: marker?.[1] === "🧠"
				? Brain
				: marker?.[1] === "📐"
					? Ruler
					: marker?.[1] === "📊"
						? Info
						: AlertTriangle;
	const content = (
		<>
			{marker && (
				<StatusIcon
					aria-hidden="true"
					className="inline-block h-3.5 w-3.5 mr-1 align-text-bottom"
				/>
			)}
			<HighlightedText
				text={
					marker ? translatedContent.slice(marker[0].length) : translatedContent
				}
				matcher={matcher}
			/>
		</>
	);
	const detail = entry.detail ? (
		<HighlightedText text={entry.detail} matcher={matcher} />
	) : null;
	const toolInput = entry.tool_input ? (
		<HighlightedText text={entry.tool_input} matcher={matcher} />
	) : null;

	const getToolInfo = (toolName: string) => {
		switch (toolName) {
			case "Read":
				return {
					icon: FileText,
					label: "Reading",
					color: "text-blue-500 bg-blue-500/10",
				};
			case "Glob":
				return {
					icon: FolderSearch,
					label: "Searching files",
					color: "text-warning bg-warning/10",
				};
			case "Grep":
				return {
					icon: Search,
					label: "Searching code",
					color: "text-success bg-success/10",
				};
			case "Edit":
				return {
					icon: Pencil,
					label: "Editing",
					color: "text-purple-500 bg-purple-500/10",
				};
			case "Write":
				return {
					icon: FileCode,
					label: "Writing",
					color: "text-cyan-500 bg-cyan-500/10",
				};
			case "Bash":
				return {
					icon: Terminal,
					label: "Running",
					color: "text-orange-500 bg-orange-500/10",
				};
			default:
				return {
					icon: Wrench,
					label: toolName,
					color: "text-muted-foreground bg-muted",
				};
		}
	};

	const formatTime = (timestamp: string) => {
		try {
			const date = new Date(timestamp);
			return formatAppDateTime(date);
		} catch {
			return "";
		}
	};

	const SubphaseBadge = () => {
		if (!entry.subphase) return null;
		return (
			<Badge
				variant="outline"
				className="text-3xs px-1 py-0 ml-1 text-muted-foreground border-muted-foreground/30"
			>
				{entry.subphase}
			</Badge>
		);
	};

	if (entry.type === "tool_start" && entry.tool_name) {
		const { icon: Icon, label, color } = getToolInfo(entry.tool_name);
		return (
			<div className="flex flex-col">
				<div
					className={cn(
						"flex items-start gap-2 rounded-md px-2 py-1 text-xs",
						color,
					)}
				>
					<Icon className="h-3 w-3 mt-0.5 shrink-0 animate-pulse" />
					<span className="font-medium shrink-0 mt-px">{label}</span>
					{entry.tool_input && (
						<span
							className="text-muted-foreground break-all whitespace-pre-wrap flex-1 min-w-0"
							title={entry.tool_input as string}
						>
							{toolInput}
						</span>
					)}
					<SubphaseBadge />
				</div>
			</div>
		);
	}

	if (entry.type === "tool_end" && entry.tool_name) {
		const { icon: Icon, color } = getToolInfo(entry.tool_name);
		return (
			<div className="flex flex-col">
				<div className="flex items-center gap-2">
					<div
						className={cn(
							"inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs",
							color,
							"opacity-60",
						)}
					>
						<Icon className="h-3 w-3" />
						<CheckCircle2 className="h-3 w-3 text-success" />
						<span className="text-muted-foreground">{t("taskReview:taskPanel.done")}</span>
					</div>
					{hasDetail && (
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className={cn(
								"flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded",
								"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
								isExpanded && "bg-secondary/50",
							)}
						>
							{isExpanded ? (
								<>
									<ChevronDown className="h-2.5 w-2.5" />
									<span>{t("tasks:logs.hideOutput")}</span>
								</>
							) : (
								<>
									<ChevronRight className="h-2.5 w-2.5" />
									<span>{t("tasks:logs.showOutput")}</span>
								</>
							)}
						</button>
					)}
				</div>
				{hasDetail && isExpanded && (
					<div className="mt-1.5 ml-4 p-2 bg-secondary/30 rounded-md border border-border/50 overflow-x-auto">
						<pre className="text-3xs text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
							{detail}
						</pre>
					</div>
				)}
			</div>
		);
	}

	if (entry.type === "error") {
		return (
			<div className="flex flex-col">
				<div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-md px-2 py-1">
					<XCircle className="h-3 w-3 mt-0.5 shrink-0" />
					<span className="break-words flex-1">{content}</span>
					<SubphaseBadge />
					{hasDetail && (
						<button
							type="button"
							onClick={() => setIsExpanded(!isExpanded)}
							className={cn(
								"flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded shrink-0",
								"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
								isExpanded && "bg-secondary/50",
							)}
						>
							{isExpanded ? (
								<ChevronDown className="h-2.5 w-2.5" />
							) : (
								<ChevronRight className="h-2.5 w-2.5" />
							)}
						</button>
					)}
				</div>
				{hasDetail && isExpanded && (
					<div className="mt-1.5 ml-4 p-2 bg-destructive/5 rounded-md border border-destructive/20 overflow-x-auto">
						<pre className="text-3xs text-destructive/80 whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
							{detail}
						</pre>
					</div>
				)}
			</div>
		);
	}

	if (entry.type === "success") {
		return (
			<div className="flex items-start gap-2 text-xs text-success bg-success/10 rounded-md px-2 py-1">
				<CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	if (entry.type === "warning") {
		return (
			<div className="flex items-start gap-2 text-xs text-warning bg-warning/10 rounded-md px-2 py-1">
				<AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	if (entry.type === "info") {
		return (
			<div className="flex items-start gap-2 text-xs text-info bg-info/10 rounded-md px-2 py-1">
				<Info className="h-3 w-3 mt-0.5 shrink-0" />
				<span className="break-words flex-1">{content}</span>
				<SubphaseBadge />
			</div>
		);
	}

	// Default text entry
	return (
		<div className="flex flex-col">
			<div className="flex items-start gap-2 text-xs text-muted-foreground py-0.5">
				<span className="text-3xs text-muted-foreground/60 tabular-nums shrink-0">
					{formatTime(entry.timestamp)}
				</span>
				<span className="break-words whitespace-pre-wrap flex-1">
					{content}
				</span>
				<SubphaseBadge />
				{hasDetail && (
					<button
						type="button"
						onClick={() => setIsExpanded(!isExpanded)}
						className={cn(
							"flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded shrink-0",
							"text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors",
							isExpanded && "bg-secondary/50",
						)}
					>
						{isExpanded ? (
							<>
								<ChevronDown className="h-2.5 w-2.5" />
								<span>{t("taskReview:taskPanel.less")}</span>
							</>
						) : (
							<>
								<ChevronRight className="h-2.5 w-2.5" />
								<span>{t("taskReview:taskPanel.more")}</span>
							</>
						)}
					</button>
				)}
			</div>
			{hasDetail && isExpanded && (
				<div className="mt-1.5 ml-12 p-2 bg-secondary/30 rounded-md border border-border/50 overflow-x-auto">
					<pre className="text-3xs text-muted-foreground whitespace-pre-wrap break-words font-mono max-h-[300px] overflow-y-auto">
						{detail}
					</pre>
				</div>
			)}
		</div>
	);
}
