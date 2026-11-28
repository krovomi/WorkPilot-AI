import type { TFunction } from "i18next";
import { Coins, Timer, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isTaskEffectivelyComplete } from "../../../shared/progress";
import type { Task, TaskPerson, TaskUsageTotals } from "../../../shared/types";
import { formatUsageValue } from "../../../shared/utils/format-usage";
import {
	durationParts,
	taskRunDurations,
} from "../../../shared/utils/task-run-duration";
import { formatCost } from "../formula-lab/formula-utils";

/**
 * What a finished card says about its run: how long its agents worked, the
 * tokens and the price they cost, who created the card and who launched it
 * (`main/task-run-facts.ts`, `shared/utils/task-run-duration.ts`). Every
 * provider counts: a part nobody reported reads « unknown », never 0.
 *
 * `TaskRunFactsRow` is the card's single line; `TaskRunFactsDetails` the
 * fuller account in the card's hover preview.
 */

/** Cards whose agents are done: done, a pull request opened, a completed review. */
export function showsRunFacts(task: Task): boolean {
	return isTaskEffectivelyComplete(task.status, task.reviewReason);
}

/** Whether two versions of a task show the same run facts (the card's memo). */
export function sameRunFacts(prev: Task, next: Task): boolean {
	const a = prev.runFacts;
	const b = next.runFacts;
	return (
		prev.statusHistory?.length === next.statusHistory?.length &&
		a?.createdBy?.name === b?.createdBy?.name &&
		a?.createdBy?.kind === b?.createdBy?.kind &&
		a?.startedBy?.name === b?.startedBy?.name &&
		a?.startedBy?.kind === b?.startedBy?.kind &&
		a?.usage?.sessions === b?.usage?.sessions &&
		a?.usage?.costUsd === b?.usage?.costUsd &&
		(a?.usage ? totalTokens(a.usage) : 0) === (b?.usage ? totalTokens(b.usage) : 0)
	);
}

export function formatDuration(ms: number, t: TFunction): string {
	const parts = durationParts(ms);
	// « 1 h », not « 1 h 0 min ».
	if (parts.unit === "hours" && parts.minutes === 0) {
		return t("tasks:runFacts.duration.hoursOnly", parts);
	}
	if (parts.unit === "days" && parts.hours === 0) {
		return t("tasks:runFacts.duration.daysOnly", parts);
	}
	return t(`tasks:runFacts.duration.${parts.unit}`, parts);
}

export function totalTokens(usage: TaskUsageTotals): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.cacheReadTokens +
		usage.cacheWriteTokens
	);
}

export function personName(person: TaskPerson | undefined, t: TFunction): string {
	if (!person) return t("tasks:runFacts.unknown");
	if (person.kind === "automation") return t("tasks:runFacts.automation");
	return person.name ?? t("tasks:runFacts.unknown");
}

function samePerson(a: TaskPerson | undefined, b: TaskPerson | undefined): boolean {
	return (
		!!a && !!b && a.kind === b.kind && !!a.name && a.name === b.name
	);
}

/** « Alice » when the same person created and launched it, else « Alice → Bob ». */
export function peopleLabel(task: Task, t: TFunction): string {
	const { createdBy, startedBy } = task.runFacts ?? {};
	if (samePerson(createdBy, startedBy) || !startedBy) {
		return personName(createdBy, t);
	}
	return t("tasks:runFacts.peopleShort", {
		creator: personName(createdBy, t),
		launcher: personName(startedBy, t),
	});
}

export function peopleTitle(task: Task, t: TFunction): string {
	const { createdBy, startedBy } = task.runFacts ?? {};
	return t("tasks:runFacts.peopleTitle", {
		creator: personName(createdBy, t),
		launcher: startedBy
			? personName(startedBy, t)
			: t("tasks:runFacts.unknown"),
	});
}

function tokensLabel(usage: TaskUsageTotals, language: string, t: TFunction): string {
	const value = formatUsageValue(totalTokens(usage), language) ?? "0";
	return usage.estimatedSessions > 0
		? t("tasks:runFacts.tokensEstimated", { value })
		: t("tasks:runFacts.tokens", { value });
}

export function TaskRunFactsRow({ task }: { readonly task: Task }) {
	const { t, i18n } = useTranslation(["tasks"]);
	if (!showsRunFacts(task)) return null;
	const { agentMs } = taskRunDurations(task.statusHistory);
	const usage = task.runFacts?.usage;
	const hasPeople = !!(task.runFacts?.createdBy || task.runFacts?.startedBy);
	return (
		<div
			data-testid="task-run-facts"
			className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted-foreground"
		>
			<span
				className="inline-flex items-center gap-1 whitespace-nowrap"
				title={t("tasks:runFacts.agentTime")}
			>
				<Timer className="h-3 w-3 shrink-0" aria-hidden="true" />
				<span className="sr-only">{t("tasks:runFacts.agentTime")}</span>
				{agentMs === undefined
					? t("tasks:runFacts.unknown")
					: formatDuration(agentMs, t)}
			</span>
			<span
				className="inline-flex items-center gap-1 whitespace-nowrap"
				title={t("tasks:runFacts.spendTitle")}
			>
				<Coins className="h-3 w-3 shrink-0" aria-hidden="true" />
				{usage ? (
					<>
						{tokensLabel(usage, i18n.language, t)}
						{usage.costUsd > 0 && (
							<span className="text-foreground/80">
								{t("tasks:runFacts.costShort", {
									cost: formatCost(usage.costUsd),
								})}
							</span>
						)}
					</>
				) : (
					t("tasks:runFacts.tokensUnknown")
				)}
			</span>
			{hasPeople && (
				<span
					className="inline-flex min-w-0 items-center gap-1"
					title={peopleTitle(task, t)}
				>
					<UserRound className="h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="sr-only">{peopleTitle(task, t)}</span>
					<span className="truncate" aria-hidden="true">
						{peopleLabel(task, t)}
					</span>
				</span>
			)}
		</div>
	);
}

export function TaskRunFactsDetails({ task }: { readonly task: Task }) {
	const { t, i18n } = useTranslation(["tasks"]);
	if (!showsRunFacts(task)) return null;
	const { agentMs, leadMs } = taskRunDurations(task.statusHistory);
	const usage = task.runFacts?.usage;
	const unknown = t("tasks:runFacts.unknown");
	const line = (label: string, value: string) =>
		t("tasks:cardType.preview.field", { label, value });
	const number = (value: number) => formatUsageValue(value, i18n.language) ?? "0";
	return (
		<div
			data-testid="task-run-facts-details"
			className="space-y-1 border-t border-border pt-2 text-muted-foreground"
		>
			<p className="font-medium text-foreground">{t("tasks:runFacts.title")}</p>
			<p>
				{line(
					t("tasks:runFacts.agentTime"),
					agentMs === undefined ? unknown : formatDuration(agentMs, t),
				)}
			</p>
			<p>
				{line(
					t("tasks:runFacts.leadTime"),
					leadMs === undefined ? unknown : formatDuration(leadMs, t),
				)}
			</p>
			<p>
				{line(
					t("tasks:runFacts.tokensLabel"),
					usage
						? t("tasks:runFacts.tokensDetail", {
								total: number(totalTokens(usage)),
								input: number(usage.inputTokens),
								output: number(usage.outputTokens),
								cache: number(usage.cacheReadTokens + usage.cacheWriteTokens),
							})
						: unknown,
				)}
			</p>
			<p>
				{line(
					t("tasks:runFacts.costLabel"),
					usage && usage.costUsd > 0 ? formatCost(usage.costUsd) : unknown,
				)}
			</p>
			{usage && usage.estimatedSessions > 0 && (
				<p>
					{t("tasks:runFacts.estimatedNote", {
						count: usage.estimatedSessions,
						total: usage.sessions,
					})}
				</p>
			)}
			{usage && usage.models.length > 0 && (
				<p>{line(t("tasks:runFacts.models"), usage.models.join(", "))}</p>
			)}
			<p>
				{line(t("tasks:runFacts.createdBy"), personName(task.runFacts?.createdBy, t))}
			</p>
			<p>
				{line(t("tasks:runFacts.startedBy"), personName(task.runFacts?.startedBy, t))}
			</p>
		</div>
	);
}
