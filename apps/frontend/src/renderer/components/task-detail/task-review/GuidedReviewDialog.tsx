/**
 * The guided review: the task's changes in the order of its plan, each
 * subtask with the description the planner wrote as its explanation, then
 * the commits no subtask recorded, then what is not committed yet.
 *
 * No model is called: the intentions are the plan's. "Viewed" is kept per
 * task and file, and is lost when the file's patch changes (a QA fix), so
 * only what moved is read again. `shared/utils/review-groups.ts` decides
 * everything shown here.
 */
import {
	AlertTriangle,
	ArrowRightLeft,
	Check,
	ChevronDown,
	ChevronRight,
	FileWarning,
	GitCommit,
	ListChecks,
	MessageSquareWarning,
	PencilLine,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ReviewGroup,
	ReviewGroupFile,
	ReviewGroups,
} from "../../../../shared/types/review-groups";
import {
	type ViewedState,
	isViewed,
	pruneViewed,
	setViewed,
} from "../../../../shared/utils/review-groups";
import { cn } from "../../../lib/utils";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { DiffViewer } from "../../ui/diff-viewer";

const STORAGE_PREFIX = "workpilot:guided-review:";

function loadViewed(taskId: string): ViewedState {
	try {
		const raw = window.localStorage.getItem(STORAGE_PREFIX + taskId);
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? (parsed as ViewedState) : {};
	} catch {
		return {}; // storage unavailable or unreadable: nothing marked viewed
	}
}

function saveViewed(taskId: string, state: ViewedState): void {
	try {
		window.localStorage.setItem(STORAGE_PREFIX + taskId, JSON.stringify(state));
	} catch {
		/* storage unavailable (quota, private mode): the marks last this session */
	}
}

interface GuidedReviewDialogProps {
	readonly open: boolean;
	readonly taskId: string;
	readonly onOpenChange: (open: boolean) => void;
	/** Opens the flat review of the final diff. */
	readonly onShowFinalDiff: () => void;
}

export function GuidedReviewDialog({
	open,
	taskId,
	onOpenChange,
	onShowFinalDiff,
}: GuidedReviewDialogProps) {
	const { t } = useTranslation(["taskReview"]);
	const [data, setData] = useState<ReviewGroups | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [viewed, setViewedState] = useState<ViewedState>({});

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await window.electronAPI.getReviewGroups(taskId);
			if (result.success && result.data) {
				const groups = result.data.groups;
				setData(result.data);
				setSelected((current) =>
					current && groups.some((g) => g.key === current) ? current : (groups[0]?.key ?? null),
				);
				const pruned = pruneViewed(loadViewed(taskId), groups);
				setViewedState(pruned);
				saveViewed(taskId, pruned);
			} else {
				setData(null);
				setError(result.error ?? "git_failed");
			}
		} catch {
			setData(null);
			setError("git_failed");
		} finally {
			setLoading(false);
		}
	}, [taskId]);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const groups = data?.groups ?? [];
	const current = groups.find((g) => g.key === selected) ?? null;
	const titles = useMemo(
		() => new Map(groups.map((g) => [g.key, groupTitle(g, t)])),
		[groups, t],
	);

	const toggle = (group: ReviewGroup, file: ReviewGroupFile, value: boolean) => {
		setViewedState((state) => {
			const next = setViewed(state, group, file, value);
			saveViewed(taskId, next);
			return next;
		});
	};

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent className="max-w-7xl max-h-[95vh] w-[95vw] h-[90vh] overflow-hidden flex flex-col">
				<AlertDialogHeader>
					<AlertDialogTitle className="flex items-center gap-2">
						<ListChecks className="h-5 w-5 text-purple-400" />
						{t("taskReview:guided.title")}
					</AlertDialogTitle>
					<AlertDialogDescription>{t("taskReview:guided.description")}</AlertDialogDescription>
				</AlertDialogHeader>

				{loading && !data ? (
					<p className="text-sm text-muted-foreground py-8 text-center">
						{t("taskReview:guided.loading")}
					</p>
				) : error ? (
					<div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
						<p>{t(`taskReview:guided.errors.${error}`, { defaultValue: t("taskReview:guided.errors.git_failed") })}</p>
						<Button variant="outline" size="sm" onClick={onShowFinalDiff}>
							{t("taskReview:guided.openFinalDiff")}
						</Button>
					</div>
				) : groups.length === 0 ? (
					<p className="text-sm text-muted-foreground py-8 text-center">{t("taskReview:guided.empty")}</p>
				) : (
					<div className="flex flex-1 min-h-0 gap-4">
						<nav aria-label={t("taskReview:guided.groups")} className="w-72 shrink-0 overflow-y-auto space-y-1 pr-1">
							{data?.approximate && (
								<p className="text-xs text-muted-foreground mb-2">{t("taskReview:guided.approximate")}</p>
							)}
							{groups.map((g) => {
								const done = g.files.filter((f) => isViewed(viewed, g, f)).length;
								const outOfPlan = g.files.filter((f) => f.outOfPlan).length;
								const notes = g.files.reduce((n, f) => n + f.qaNotes.length, 0);
								return (
									<button
										key={g.key}
										type="button"
										onClick={() => setSelected(g.key)}
										aria-current={g.key === selected ? "true" : undefined}
										className={cn(
											"w-full text-left rounded-md border px-3 py-2 text-sm transition-colors",
											g.key === selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
										)}
									>
										<span className="flex items-center gap-2 font-medium">
											<GroupIcon group={g} />
											<span className="truncate">{titles.get(g.key)}</span>
										</span>
										<span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
											<span>{t("taskReview:guided.viewedCount", { done, total: g.files.length })}</span>
											{outOfPlan > 0 && (
												<Badge variant="warning">{t("taskReview:guided.outOfPlanCount", { count: outOfPlan })}</Badge>
											)}
											{notes > 0 && <Badge variant="destructive">{t("taskReview:guided.qaCount", { count: notes })}</Badge>}
										</span>
									</button>
								);
							})}
						</nav>
						<section className="flex-1 min-w-0 overflow-y-auto space-y-3">
							{current && (
								<GroupView
									group={current}
									viewed={viewed}
									titles={titles}
									onToggle={toggle}
									onShowFinalDiff={onShowFinalDiff}
								/>
							)}
							{(data?.unanchoredQa.length ?? 0) > 0 && (
								<div className="rounded-md border border-border p-3 text-sm">
									<p className="font-medium mb-1">{t("taskReview:guided.unanchoredQa")}</p>
									<ul className="space-y-1">
										{data?.unanchoredQa.map((n) => (
											<li key={`${n.file}:${n.line}:${n.title}`} className="text-muted-foreground">
												<code>{n.file}{n.line ? `:${n.line}` : ""}</code> {n.title}
											</li>
										))}
									</ul>
								</div>
							)}
						</section>
					</div>
				)}

				<AlertDialogFooter>
					<Button variant="ghost" onClick={onShowFinalDiff}>
						{t("taskReview:guided.openFinalDiff")}
					</Button>
					<AlertDialogCancel>{t("taskReview:guided.close")}</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

type T = ReturnType<typeof useTranslation>["t"];

function groupTitle(group: ReviewGroup, t: T): string {
	if (group.kind === "uncommitted") return t("taskReview:guided.uncommitted");
	const base = group.title || group.subtaskId || group.to?.slice(0, 8) || "";
	return group.parts ? t("taskReview:guided.part", { title: base, part: group.part, parts: group.parts }) : base;
}

function GroupIcon({ group }: { readonly group: ReviewGroup }) {
	if (group.kind === "subtask") return <ListChecks className="h-4 w-4 shrink-0 text-purple-400" />;
	if (group.kind === "commit") return <GitCommit className="h-4 w-4 shrink-0 text-info" />;
	return <PencilLine className="h-4 w-4 shrink-0 text-warning" />;
}

function GroupView({
	group,
	viewed,
	titles,
	onToggle,
	onShowFinalDiff,
}: {
	readonly group: ReviewGroup;
	readonly viewed: ViewedState;
	readonly titles: Map<string, string>;
	readonly onToggle: (group: ReviewGroup, file: ReviewGroupFile, value: boolean) => void;
	readonly onShowFinalDiff: () => void;
}) {
	const { t } = useTranslation(["taskReview"]);
	return (
		<>
			<header className="space-y-1">
				<h3 className="font-medium">{titles.get(group.key)}</h3>
				{group.kind === "commit" && <p className="text-xs text-muted-foreground">{t("taskReview:guided.unrecordedCommit")}</p>}
				{group.description && group.description !== group.title && (
					<p className="text-sm text-muted-foreground whitespace-pre-wrap">{group.description}</p>
				)}
			</header>
			{group.files.map((file) => (
				<FileView
					key={file.path}
					group={group}
					file={file}
					viewed={isViewed(viewed, group, file)}
					titles={titles}
					onToggle={onToggle}
					onShowFinalDiff={onShowFinalDiff}
				/>
			))}
		</>
	);
}

function FileView({
	group,
	file,
	viewed,
	titles,
	onToggle,
	onShowFinalDiff,
}: {
	readonly group: ReviewGroup;
	readonly file: ReviewGroupFile;
	readonly viewed: boolean;
	readonly titles: Map<string, string>;
	readonly onToggle: (group: ReviewGroup, file: ReviewGroupFile, value: boolean) => void;
	readonly onShowFinalDiff: () => void;
}) {
	const { t } = useTranslation(["taskReview"]);
	const [expanded, setExpanded] = useState(!viewed);
	useEffect(() => setExpanded(!viewed), [viewed]);
	const checkboxId = `viewed-${group.key}-${file.path}`;
	return (
		<article className="rounded-md border border-border">
			<div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					className="flex items-center gap-1 min-w-0 flex-1 text-left text-sm font-mono"
				>
					{expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
					<span className="truncate">{file.path}</span>
				</button>
				<span className="text-xs text-success">+{file.additions}</span>
				<span className="text-xs text-destructive">-{file.deletions}</span>
				{file.outOfPlan && (
					<Badge variant="warning" title={t("taskReview:guided.outOfPlanHint")}>
						<FileWarning className="h-3 w-3 mr-1" />
						{t("taskReview:guided.outOfPlan")}
					</Badge>
				)}
				<label htmlFor={checkboxId} className="flex items-center gap-1 text-xs">
					<Checkbox
						id={checkboxId}
						checked={viewed}
						onCheckedChange={(v) => onToggle(group, file, v === true)}
					/>
					{viewed ? <Check className="h-3 w-3 text-success" /> : null}
					{t("taskReview:guided.viewed")}
				</label>
			</div>
			{file.touchedLater.length > 0 && (
				<p className="flex items-center gap-1 px-3 py-1 text-xs text-warning border-t border-border">
					<AlertTriangle className="h-3 w-3" />
					{t("taskReview:guided.touchedLater", {
						groups: file.touchedLater.map((k) => titles.get(k) ?? k).join(", "),
					})}
					<button type="button" onClick={onShowFinalDiff} className="underline ml-1">
						{t("taskReview:guided.seeFinal")}
					</button>
				</p>
			)}
			{file.moved.map((m) => (
				<p key={`${m.direction}:${m.otherPath}:${m.preview}`} className="flex items-center gap-1 px-3 py-1 text-xs text-info border-t border-border">
					<ArrowRightLeft className="h-3 w-3" />
					{t(m.direction === "in" ? "taskReview:guided.movedFrom" : "taskReview:guided.movedTo", {
						count: m.lines,
						path: m.otherPath,
					})}
					<code className="truncate text-muted-foreground">{m.preview}</code>
				</p>
			))}
			{file.qaNotes.map((n) => (
				<p key={`${n.line}:${n.title}`} className="flex items-center gap-1 px-3 py-1 text-xs text-destructive border-t border-border">
					<MessageSquareWarning className="h-3 w-3 shrink-0" />
					<span className="font-medium">{n.severity}</span>
					{n.line ? <span>{t("taskReview:guided.line", { line: n.line })}</span> : null}
					<span>{n.title}</span>
				</p>
			))}
			{expanded && (
				<div className="border-t border-border">
					{file.patch ? (
						<DiffViewer patch={file.patch} />
					) : (
						<p className="px-3 py-2 text-xs text-muted-foreground">{t("taskReview:guided.noPatch")}</p>
					)}
				</div>
			)}
		</article>
	);
}
