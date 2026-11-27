/**
 * « Interroger le tableau » (docs/architecture/board-ask.md): a question in
 * any language, answered with every ticket of the board that relates to it,
 * whatever language the tickets were written in. Helps a product owner see
 * whether a feature was already built, even partly.
 */

import { Archive, ArrowUp, Loader2, MessageSquareText, RotateCcw, Search, Sparkles } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoardAskCoverage, BoardAskMatch, BoardAskState, Task } from "../../../../shared/types";
import { BOARD_ASK_LIMITS } from "../../../../shared/types/board-ask";
import { formatAppDate } from "../../../lib/date-format";
import { cn } from "../../../lib/utils";
import { type BoardAskEntry, useBoardAskStore } from "../../../stores/board-ask-store";
import { useTaskStore } from "../../../stores/task-store";
import { Chip, type Tone } from "../../charter";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";

const EMPTY: BoardAskEntry[] = [];
const EXAMPLES = ["adminPage", "export", "login"] as const;

const COVERAGE_TONE: Readonly<Record<BoardAskCoverage, Tone>> = {
	full: "green",
	partial: "amber",
	related: "muted",
};

const STATE_TONE: Readonly<Record<BoardAskState, Tone>> = {
	done: "green",
	in_review: "violet",
	in_progress: "blue",
	planned: "muted",
	failed: "red",
	abandoned: "muted",
};

/** The answer's text with its `[n]` citations as buttons to the n-th ticket. */
function AnswerText({
	answer,
	matches,
	onCite,
}: {
	readonly answer: string;
	readonly matches: readonly BoardAskMatch[];
	readonly onCite: (index: number) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	// Each piece keyed by where it starts in the answer: stable, unique.
	let offset = 0;
	const parts = answer.split(/(\[\d+\])/g).map((text) => {
		const at = offset;
		offset += text.length;
		return { text, at };
	});
	return (
		<p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
			{parts.map(({ text: part, at }) => {
				const cited = /^\[(\d+)\]$/.exec(part);
				const index = cited ? Number(cited[1]) - 1 : -1;
				const match = index >= 0 ? matches[index] : undefined;
				if (!match) return <span key={at}>{part}</span>;
				return (
					<button
						key={at}
						type="button"
						onClick={() => onCite(index)}
						title={match.title}
						aria-label={t("kanban.ask.citation", { index: index + 1, title: match.title })}
						className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-primary/15 px-1 align-baseline text-[10px] font-semibold text-primary hover:bg-primary/25"
					>
						{index + 1}
					</button>
				);
			})}
		</p>
	);
}

/** The element id of a ticket row, unique across the conversation. */
const matchElementId = (entryId: number, index: number) => `board-ask-match-${entryId}-${index}`;

function MatchRow({
	entryId,
	match,
	index,
	highlighted,
	onOpen,
}: {
	readonly entryId: number;
	readonly match: BoardAskMatch;
	readonly index: number;
	readonly highlighted: boolean;
	readonly onOpen?: () => void;
}) {
	const { t } = useTranslation(["tasks"]);
	return (
		<li id={matchElementId(entryId, index)}>
			<button
				type="button"
				onClick={onOpen}
				disabled={!onOpen}
				aria-current={highlighted ? "true" : undefined}
				className={cn(
					"group flex w-full items-start gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-left transition-colors",
					onOpen && "hover:border-primary/40 hover:bg-primary/5",
					highlighted && "border-primary/60 bg-primary/10",
				)}
			>
				<span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
					{index + 1}
				</span>
				<span className="min-w-0 flex-1 space-y-1">
					<span className="block truncate text-sm font-medium text-foreground group-hover:text-primary">
						{match.title}
					</span>
					{match.reason && <span className="block text-xs text-muted-foreground">{match.reason}</span>}
					<span className="flex flex-wrap items-center gap-1.5 pt-0.5">
						{match.coverage && (
							<Chip tone={COVERAGE_TONE[match.coverage]}>{t(`kanban.ask.coverage.${match.coverage}`)}</Chip>
						)}
						<Chip tone={STATE_TONE[match.state]}>
							{t(`kanban.ask.state.${match.state}`)}
						</Chip>
						{match.archived && (
							<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
								<Archive className="h-3 w-3" aria-hidden />
								{t("kanban.ask.archived")}
							</span>
						)}
						{match.updatedAt && (
							<span className="text-[11px] text-muted-foreground tabular-nums">
								{formatAppDate(match.updatedAt)}
							</span>
						)}
					</span>
				</span>
			</button>
		</li>
	);
}

function EntryView({
	entry,
	onOpenTask,
}: {
	readonly entry: BoardAskEntry;
	readonly onOpenTask: (taskId: string) => (() => void) | undefined;
}) {
	const { t } = useTranslation(["tasks"]);
	const [highlighted, setHighlighted] = useState<number | null>(null);
	const result = entry.result;
	const cite = (index: number) => {
		setHighlighted(index);
		document.getElementById(matchElementId(entry.id, index))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	};
	return (
		<div className="scroll-mt-4 space-y-3" data-board-ask-entry={entry.id}>
			<div className="flex justify-end">
				<p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
					{entry.question}
				</p>
			</div>
			{entry.status === "pending" && (
				<p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
					<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
					{t("kanban.ask.searching")}
				</p>
			)}
			{entry.status === "error" && (
				<p className="text-sm text-destructive" role="alert">
					{entry.error === "server_project" ? t("kanban.ask.serverProject") : t("kanban.ask.failed")}
				</p>
			)}
			{result && (
				<div className="space-y-3 rounded-2xl rounded-bl-md border border-border/60 bg-muted/30 p-3.5">
					<div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
						{result.mode === "ai" ? (
							<span className="inline-flex items-center gap-1 font-medium text-primary">
								<Sparkles className="h-3 w-3" aria-hidden />
								{t("kanban.ask.modeAi")}
							</span>
						) : (
							<span className="inline-flex items-center gap-1 font-medium">
								<Search className="h-3 w-3" aria-hidden />
								{t("kanban.ask.modeKeywords")}
							</span>
						)}
						<span>{t("kanban.ask.searched", { count: result.searched })}</span>
					</div>
					{result.answer && <AnswerText answer={result.answer} matches={result.matches} onCite={cite} />}
					{result.mode === "keywords" && result.matches.length > 0 && (
						<p className="text-xs text-muted-foreground">{t("kanban.ask.keywordsHint")}</p>
					)}
					{result.matches.length === 0 && !result.answer && (
						<p className="text-sm text-muted-foreground">{t("kanban.ask.noMatch")}</p>
					)}
					{result.matches.length > 0 && (
						<ul className="wp-scope space-y-2">
							{result.matches.map((match, index) => (
								<MatchRow
									key={match.taskId}
									entryId={entry.id}
									match={match}
									index={index}
									highlighted={highlighted === index}
									onOpen={onOpenTask(match.taskId)}
								/>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

export interface BoardAskPanelProps {
	readonly projectId: string;
	readonly onOpenTask?: (task: Task) => void;
}

export function BoardAskPanel({ projectId, onOpenTask }: BoardAskPanelProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const open = useBoardAskStore((s) => s.open);
	const setOpen = useBoardAskStore((s) => s.setOpen);
	const entries = useBoardAskStore((s) => s.conversations[projectId] ?? EMPTY);
	const ask = useBoardAskStore((s) => s.ask);
	const clear = useBoardAskStore((s) => s.clear);
	const tasks = useTaskStore((s) => s.tasks);
	const [draft, setDraft] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const pending = entries.some((e) => e.status === "pending");

	useEffect(() => {
		// The latest question at the top: its answer reads from the start.
		const last = entries.at(-1);
		if (!last) return;
		listRef.current
			?.querySelector(`[data-board-ask-entry="${last.id}"]`)
			?.scrollIntoView({ block: "start" });
	}, [entries]);

	const submit = (text: string) => {
		if (!text.trim() || pending) return;
		void ask(projectId, text);
		setDraft("");
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit(draft);
		}
	};

	const openTask = (taskId: string) => {
		const task = tasks.find((candidate) => candidate.id === taskId);
		if (!task || !onOpenTask) return undefined;
		return () => {
			setOpen(false);
			onOpenTask(task);
		};
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="relative flex h-[min(85vh,820px)] max-w-3xl flex-col p-0">
				<DialogHeader className="shrink-0 pr-16">
					<DialogTitle className="flex items-center gap-2">
						<MessageSquareText className="h-5 w-5 text-primary" aria-hidden />
						{t("kanban.ask.title")}
					</DialogTitle>
					<DialogDescription>{t("kanban.ask.description")}</DialogDescription>
				</DialogHeader>

				<div ref={listRef} className="-mx-6 min-h-0 flex-1 space-y-5 overflow-y-auto border-y border-border/60 px-6 py-4">
					{entries.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center gap-4 text-center">
							<span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
								<Sparkles className="h-5 w-5" aria-hidden />
							</span>
							<p className="max-w-md text-sm text-muted-foreground">{t("kanban.ask.emptyHint")}</p>
							<div className="flex flex-wrap justify-center gap-2">
								{EXAMPLES.map((key) => (
									<button
										key={key}
										type="button"
										onClick={() => submit(t(`kanban.ask.examples.${key}`))}
										className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5"
									>
										{t(`kanban.ask.examples.${key}`)}
									</button>
								))}
							</div>
						</div>
					) : (
						entries.map((entry) => <EntryView key={entry.id} entry={entry} onOpenTask={openTask} />)
					)}
				</div>

				<div className="shrink-0 space-y-2 pt-3">
					<div className="flex items-end gap-2">
						<Textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value.slice(0, BOARD_ASK_LIMITS.question))}
							onKeyDown={onKeyDown}
							placeholder={t("kanban.ask.placeholder")}
							aria-label={t("kanban.ask.placeholder")}
							rows={2}
							className="min-h-[52px] resize-none"
							autoFocus
						/>
						<Button
							size="icon"
							className="h-[52px] w-11 shrink-0"
							onClick={() => submit(draft)}
							disabled={!draft.trim() || pending}
							aria-label={t("kanban.ask.send")}
							title={t("kanban.ask.send")}
						>
							{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
						</Button>
					</div>
					<div className="flex items-center justify-between gap-3">
						<p className="text-[11px] text-muted-foreground">{t("kanban.ask.privacy")}</p>
						{entries.length > 0 && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 shrink-0 gap-1.5 text-xs"
								onClick={() => clear(projectId)}
								disabled={pending}
							>
								<RotateCcw className="h-3.5 w-3.5" aria-hidden />
								{t("kanban.ask.newConversation")}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
