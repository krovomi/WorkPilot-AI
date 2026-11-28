/**
 * « Vérifier une idée » (docs/architecture/board-ask.md, lot 3): the product
 * owner pastes a feature they plan, in any language; each of its requirements
 * comes back done, partly done or missing, with the tickets that hold it, and
 * one button creates a card with only what is left.
 */

import {
	CircleCheck,
	CircleDashed,
	CircleQuestionMark,
	CircleX,
	ExternalLink,
	Lightbulb,
	Loader2,
	RotateCcw,
	SquarePlus,
} from "lucide-react";
import { type ComponentType, type KeyboardEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoardIdeaRequirement, BoardIdeaResult, BoardIdeaVerdict } from "../../../../shared/types";
import { BOARD_ASK_LIMITS, BOARD_IDEA_VERDICTS } from "../../../../shared/types/board-ask";
import { cn } from "../../../lib/utils";
import { type BoardIdeaCheck, useBoardAskStore } from "../../../stores/board-ask-store";
import { createTask } from "../../../stores/task-store";
import { Chip, type Tone } from "../../charter";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { MatchRow, ModeLine, SemanticModeSelect } from "./board-ask-parts";
import { hasWorkLeft, ideaCard } from "./idea-card";

const VERDICT_TONE: Readonly<Record<BoardIdeaVerdict, Tone>> = {
	done: "green",
	partial: "amber",
	missing: "red",
	unknown: "muted",
};

const VERDICT_ICON: Readonly<Record<BoardIdeaVerdict, ComponentType<{ className?: string }>>> = {
	done: CircleCheck,
	partial: CircleDashed,
	missing: CircleX,
	unknown: CircleQuestionMark,
};

const VERDICT_COLOR: Readonly<Record<BoardIdeaVerdict, string>> = {
	done: "text-success",
	partial: "text-warning",
	missing: "text-destructive",
	unknown: "text-muted-foreground",
};

function RequirementRow({
	requirement,
	index,
	onOpenTask,
}: {
	readonly requirement: BoardIdeaRequirement;
	readonly index: number;
	readonly onOpenTask: (taskId: string) => (() => void) | undefined;
}) {
	const { t } = useTranslation(["tasks"]);
	const Icon = VERDICT_ICON[requirement.verdict];
	return (
		<li className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-3" data-verdict={requirement.verdict}>
			<div className="flex items-start gap-2.5">
				<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", VERDICT_COLOR[requirement.verdict])} aria-hidden />
				<div className="min-w-0 flex-1 space-y-1">
					<p className="text-sm font-medium text-foreground">{requirement.text}</p>
					{requirement.reason && <p className="text-xs text-muted-foreground">{requirement.reason}</p>}
				</div>
				<Chip tone={VERDICT_TONE[requirement.verdict]}>{t(`kanban.ask.idea.verdict.${requirement.verdict}`)}</Chip>
			</div>
			{requirement.matches.length > 0 && (
				<ul className="wp-scope space-y-1.5 pl-6">
					{requirement.matches.map((match, i) => (
						<MatchRow
							key={match.taskId}
							entryId={index}
							match={match}
							index={i}
							highlighted={false}
							onOpen={onOpenTask(match.taskId)}
							idPrefix="board-idea-match"
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function Tally({ result }: { readonly result: BoardIdeaResult }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div className="flex flex-wrap gap-1.5">
			{BOARD_IDEA_VERDICTS.map((verdict) => {
				const count = result.requirements.filter((r) => r.verdict === verdict).length;
				if (count === 0) return null;
				return (
					<Chip key={verdict} tone={VERDICT_TONE[verdict]}>
						{t(`kanban.ask.idea.tally.${verdict}`, { count })}
					</Chip>
				);
			})}
		</div>
	);
}

function ResultView({
	projectId,
	check,
	result,
	onOpenTask,
}: {
	readonly projectId: string;
	readonly check: BoardIdeaCheck;
	readonly result: BoardIdeaResult;
	readonly onOpenTask: (taskId: string) => (() => void) | undefined;
}) {
	const { t } = useTranslation(["tasks"]);
	const markIdeaCard = useBoardAskStore((s) => s.markIdeaCard);
	const [creating, setCreating] = useState(false);
	const [failed, setFailed] = useState(false);
	const workLeft = hasWorkLeft(result);
	const openCreated = check.createdTaskId ? onOpenTask(check.createdTaskId) : undefined;

	const create = async () => {
		setCreating(true);
		setFailed(false);
		const card = ideaCard(result, check.idea, t);
		const task = await createTask(projectId, card.title, card.description);
		setCreating(false);
		if (task) markIdeaCard(projectId, task.id);
		else setFailed(true);
	};

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				{result.title && <h3 className="text-base font-semibold text-foreground">{result.title}</h3>}
				<ModeLine result={result} />
				<Tally result={result} />
				{result.summary && <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{result.summary}</p>}
				{result.mode !== "ai" && result.requirements.length > 0 && (
					<p className="text-xs text-muted-foreground">{t("kanban.ask.idea.unjudgedHint")}</p>
				)}
			</div>
			{result.requirements.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("kanban.ask.idea.noRequirement")}</p>
			) : (
				<ol className="space-y-2">
					{result.requirements.map((requirement, index) => (
						<RequirementRow
							key={`${index}-${requirement.text}`}
							requirement={requirement}
							index={index}
							onOpenTask={onOpenTask}
						/>
					))}
				</ol>
			)}
			{result.requirements.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border/80 p-3">
					{check.createdTaskId ? (
						<>
							<span className="flex items-center gap-1.5 text-sm text-foreground" role="status">
								<CircleCheck className="h-4 w-4 text-success" aria-hidden />
								{t("kanban.ask.idea.created")}
							</span>
							{openCreated && (
								<Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={openCreated}>
									<ExternalLink className="h-3.5 w-3.5" aria-hidden />
									{t("kanban.ask.idea.openCard")}
								</Button>
							)}
						</>
					) : workLeft ? (
						<>
							<Button size="sm" className="gap-1.5" onClick={() => void create()} disabled={creating}>
								{creating ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
								) : (
									<SquarePlus className="h-3.5 w-3.5" aria-hidden />
								)}
								{t("kanban.ask.idea.createCard")}
							</Button>
							<span className="min-w-0 flex-1 basis-48 text-2xs text-muted-foreground">
								{t("kanban.ask.idea.createHint")}
							</span>
						</>
					) : (
						<span className="flex items-center gap-1.5 text-sm text-foreground">
							<CircleCheck className="h-4 w-4 text-success" aria-hidden />
							{t("kanban.ask.idea.allDone")}
						</span>
					)}
					{failed && (
						<p className="w-full text-xs text-destructive" role="alert">
							{t("kanban.ask.idea.createFailed")}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

export interface IdeaCheckViewProps {
	readonly projectId: string;
	readonly onOpenTask: (taskId: string) => (() => void) | undefined;
}

export function IdeaCheckView({ projectId, onOpenTask }: IdeaCheckViewProps) {
	const { t } = useTranslation(["tasks"]);
	const check = useBoardAskStore((s) => s.ideas[projectId]);
	const checkIdea = useBoardAskStore((s) => s.checkIdea);
	const clearIdea = useBoardAskStore((s) => s.clearIdea);
	const [draft, setDraft] = useState(check?.idea ?? "");
	const pending = check?.status === "pending";

	const submit = () => {
		if (!draft.trim() || pending) return;
		void checkIdea(projectId, draft);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter writes a new line in a description; Ctrl or Cmd + Enter checks it.
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	const restart = () => {
		clearIdea(projectId);
		setDraft("");
	};

	return (
		<>
			<div className="-mx-6 min-h-0 flex-1 space-y-4 overflow-y-auto border-y border-border/60 px-6 py-4">
				<div className="space-y-2">
					<Textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value.slice(0, BOARD_ASK_LIMITS.idea))}
						onKeyDown={onKeyDown}
						placeholder={t("kanban.ask.idea.placeholder")}
						aria-label={t("kanban.ask.idea.label")}
						rows={check ? 3 : 8}
						className="resize-y"
						autoFocus
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" className="gap-1.5" onClick={submit} disabled={!draft.trim() || pending}>
							{pending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
							) : (
								<Lightbulb className="h-3.5 w-3.5" aria-hidden />
							)}
							{t("kanban.ask.idea.check")}
						</Button>
						<span className="text-2xs text-muted-foreground tabular-nums">
							{t("kanban.ask.idea.length", { count: draft.length, max: BOARD_ASK_LIMITS.idea })}
						</span>
					</div>
				</div>

				{!check && <p className="text-sm text-muted-foreground">{t("kanban.ask.idea.emptyHint")}</p>}
				{pending && (
					<p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
						{t("kanban.ask.idea.checking")}
					</p>
				)}
				{check?.status === "error" && (
					<p className="text-sm text-destructive" role="alert">
						{check.error === "server_project" ? t("kanban.ask.serverProject") : t("kanban.ask.idea.failed")}
					</p>
				)}
				{check?.result && (
					<ResultView projectId={projectId} check={check} result={check.result} onOpenTask={onOpenTask} />
				)}
			</div>

			<div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-3">
				<p className="min-w-0 flex-1 basis-64 text-2xs text-muted-foreground">{t("kanban.ask.privacy")}</p>
				<SemanticModeSelect />
				{check && (
					<Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 text-xs" onClick={restart} disabled={pending}>
						<RotateCcw className="h-3.5 w-3.5" aria-hidden />
						{t("kanban.ask.idea.another")}
					</Button>
				)}
			</div>
		</>
	);
}
