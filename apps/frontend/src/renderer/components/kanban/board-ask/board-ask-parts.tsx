/**
 * Pieces of « Interroger le tableau » shared by its two tabs: how the tickets
 * were found, whether they are ranked by meaning, and one ticket row.
 */

import { Archive, Languages, Search, Sparkles } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type {
	BoardAskCoverage,
	BoardAskMatch,
	BoardAskResult,
	BoardAskSemanticMode,
	BoardAskState,
} from "../../../../shared/types";
import { BOARD_ASK_SEMANTIC_MODES } from "../../../../shared/types/board-ask";
import { formatAppDate } from "../../../lib/date-format";
import { cn } from "../../../lib/utils";
import { saveSettings, useSettingsStore } from "../../../stores/settings-store";
import { Chip, type Tone } from "../../charter";
import { NativeSelect } from "../../ui/native-select";

export const COVERAGE_TONE: Readonly<Record<BoardAskCoverage, Tone>> = {
	full: "green",
	partial: "amber",
	related: "muted",
};

export const STATE_TONE: Readonly<Record<BoardAskState, Tone>> = {
	done: "green",
	in_review: "violet",
	in_progress: "blue",
	planned: "muted",
	failed: "red",
	abandoned: "muted",
};

export /** How the tickets were found: the model's answer, by meaning, or by keywords. */
function ModeLine({ result }: { readonly result: Pick<BoardAskResult, "mode" | "searched" | "semantic"> }) {
	const { t } = useTranslation(["tasks"]);
	const semantic = result.semantic;
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
			{result.mode === "ai" && (
				<span className="inline-flex items-center gap-1 font-medium text-primary">
					<Sparkles className="h-3 w-3" aria-hidden />
					{t("kanban.ask.modeAi")}
				</span>
			)}
			{result.mode === "semantic" && (
				<span className="inline-flex items-center gap-1 font-medium">
					<Languages className="h-3 w-3" aria-hidden />
					{t("kanban.ask.modeSemantic")}
				</span>
			)}
			{result.mode === "keywords" && (
				<span className="inline-flex items-center gap-1 font-medium">
					<Search className="h-3 w-3" aria-hidden />
					{t("kanban.ask.modeKeywords")}
				</span>
			)}
			<span>{t("kanban.ask.searched", { count: result.searched })}</span>
			{semantic && (
				<span title={t("kanban.ask.semanticTitle")}>
					{t(`kanban.ask.semanticSource.${semantic.kind}`, {
						model: semantic.model,
						provider: semantic.provider,
					})}
				</span>
			)}
			{semantic && semantic.indexed < semantic.total && (
				<span>{t("kanban.ask.semanticPartial", { indexed: semantic.indexed, total: semantic.total })}</span>
			)}
		</div>
	);
}

/** The element id of a ticket row, unique across the conversation. */
export const matchElementId = (entryId: number, index: number, prefix = "board-ask-match") =>
	`${prefix}-${entryId}-${index}`;

export function MatchRow({
	entryId,
	match,
	index,
	highlighted,
	onOpen,
	idPrefix,
}: {
	readonly entryId: number;
	readonly match: BoardAskMatch;
	readonly index: number;
	readonly highlighted: boolean;
	readonly onOpen?: () => void;
	/** Keeps the row ids of the two tabs apart. */
	readonly idPrefix?: string;
}) {
	const { t } = useTranslation(["tasks"]);
	return (
		<li id={matchElementId(entryId, index, idPrefix)}>
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
				<span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-muted text-2xs font-semibold tabular-nums text-muted-foreground">
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
							<span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
								<Archive className="h-3 w-3" aria-hidden />
								{t("kanban.ask.archived")}
							</span>
						)}
						{match.updatedAt && (
							<span className="text-2xs text-muted-foreground tabular-nums">
								{formatAppDate(match.updatedAt)}
							</span>
						)}
					</span>
				</span>
			</button>
		</li>
	);
}

/** Whether the tickets are also ranked by meaning, saved in the settings. */
export function SemanticModeSelect() {
	const { t } = useTranslation(["tasks"]);
	const value = useSettingsStore((s) => s.settings.boardAskSemantic) ?? "auto";
	const id = useId();
	return (
		<div className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
			<Languages className="h-3.5 w-3.5" aria-hidden />
			<label htmlFor={id}>{t("kanban.ask.semanticMode.label")}</label>
			<NativeSelect
				id={id}
				value={value}
				onChange={(event) => void saveSettings({ boardAskSemantic: event.target.value as BoardAskSemanticMode })}
				className="h-7 px-1.5 text-2xs"
				title={t(`kanban.ask.semanticMode.hint.${value}`)}
			>
				{BOARD_ASK_SEMANTIC_MODES.map((mode) => (
					<option key={mode} value={mode}>
						{t(`kanban.ask.semanticMode.${mode}`)}
					</option>
				))}
			</NativeSelect>
		</div>
	);
}
