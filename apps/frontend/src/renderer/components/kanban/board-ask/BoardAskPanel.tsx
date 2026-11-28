/**
 * « Interroger le tableau » (docs/architecture/board-ask.md): a question in
 * any language, answered with every ticket of the board that relates to it,
 * whatever language the tickets were written in. Helps a product owner see
 * whether a feature was already built, even partly; its second tab checks a
 * planned feature requirement by requirement (`IdeaCheckView.tsx`).
 */

import { ArrowUp, Lightbulb, Loader2, MessageSquareText, RotateCcw, Sparkles } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoardAskMatch, Task } from "../../../../shared/types";
import { BOARD_ASK_LIMITS } from "../../../../shared/types/board-ask";
import { type BoardAskEntry, type BoardAskTab, useBoardAskStore } from "../../../stores/board-ask-store";
import { cn } from "../../../lib/utils";
import { useTaskStore } from "../../../stores/task-store";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";
import { MatchRow, ModeLine, matchElementId, SemanticModeSelect, SourcesMenu } from "./board-ask-parts";
import { IdeaCheckView } from "./IdeaCheckView";

const EMPTY: BoardAskEntry[] = [];
const EXAMPLES = ["adminPage", "export", "login"] as const;

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
						className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-primary/15 px-1 align-baseline text-3xs font-semibold text-primary hover:bg-primary/25"
					>
						{index + 1}
					</button>
				);
			})}
		</p>
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
					<ModeLine result={result} />
					{result.answer && <AnswerText answer={result.answer} matches={result.matches} onCite={cite} />}
					{result.mode !== "ai" && result.matches.length > 0 && (
						<p className="text-xs text-muted-foreground">
							{t(result.mode === "semantic" ? "kanban.ask.semanticHint" : "kanban.ask.keywordsHint")}
						</p>
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

const TABS: readonly { id: BoardAskTab; icon: typeof MessageSquareText }[] = [
	{ id: "ask", icon: MessageSquareText },
	{ id: "idea", icon: Lightbulb },
];

/** Ask a question, or check an idea. */
function TabSwitch({ tab, onChange }: { readonly tab: BoardAskTab; readonly onChange: (tab: BoardAskTab) => void }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div role="tablist" aria-label={t("kanban.ask.tabs.label")} className="flex shrink-0 gap-1 rounded-xl bg-muted/60 p-1">
			{TABS.map(({ id, icon: Icon }) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={tab === id}
					onClick={() => onChange(id)}
					className={cn(
						"flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
						tab === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
					)}
				>
					<Icon className="h-3.5 w-3.5" aria-hidden />
					{t(`kanban.ask.tabs.${id}`)}
				</button>
			))}
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
	const tab = useBoardAskStore((s) => s.tab);
	const setTab = useBoardAskStore((s) => s.setTab);
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
					<DialogDescription>{t(tab === "idea" ? "kanban.ask.idea.description" : "kanban.ask.description")}</DialogDescription>
				</DialogHeader>

				<TabSwitch tab={tab} onChange={setTab} />

				{tab === "idea" ? (
					<IdeaCheckView projectId={projectId} onOpenTask={openTask} />
				) : (
				<>
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
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
						<p className="min-w-0 flex-1 basis-64 text-2xs text-muted-foreground">{t("kanban.ask.privacy")}</p>
						<SourcesMenu />
						<SemanticModeSelect />
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
				</>
				)}
			</DialogContent>
		</Dialog>
	);
}
