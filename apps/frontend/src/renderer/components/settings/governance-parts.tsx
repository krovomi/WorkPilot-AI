import { Clock, FileLock2, Gauge, Repeat, ShieldAlert } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type {
	GovernanceMetrics,
	GovernanceReport,
	PolicyAuditEvent,
	PolicyDecision,
} from "../../../shared/types/governance";
import { formatAppDateTime } from "../../lib/date-format";
import { Chip, Chips, Notice, type Tone } from "../charter";

/**
 * What the governance panel of a project of this computer and the one of a
 * server project both draw: the policy's sections, its counts, its decisions.
 */

const DECISION_TONES: Record<PolicyDecision, Tone> = {
	deny: "red",
	review: "violet",
	approved: "green",
	warn: "amber",
	outside_hours: "blue",
	budget_exceeded: "amber",
	invalid_policy: "red",
	tool_loop: "amber",
};

function DecisionLine({ event }: { readonly event: PolicyAuditEvent }): React.ReactElement {
	const { t } = useTranslation("settings");
	return (
		<li className="flex flex-wrap items-baseline gap-2 text-xs">
			<Chip tone={DECISION_TONES[event.decision]}>{t(`governance.decisions.${event.decision}`)}</Chip>
			{event.rules.length > 0 && <span className="font-mono">{event.rules.join(", ")}</span>}
			{event.target && (
				<span className="wp-meta break-all font-mono">
					{event.tool ? `${event.tool} · ` : ""}
					{event.target}
				</span>
			)}
			{event.approvedBy && (
				<span className="wp-meta">{t("governance.approvedBy", { name: event.approvedBy })}</span>
			)}
			<span className="wp-meta ml-auto">
				{[event.task, event.provider, event.model, event.user].filter(Boolean).join(" · ")}
				{" · "}
				{formatAppDateTime(event.at)}
			</span>
		</li>
	);
}

function GlobList({ globs, empty }: { readonly globs: readonly string[]; readonly empty: string }) {
	if (globs.length === 0) return <p className="wp-muted text-xs">{empty}</p>;
	return (
		<Chips>
			{globs.map((glob) => (
				<Chip key={glob} tone="muted" dot={false}>
					<code>{glob}</code>
				</Chip>
			))}
		</Chips>
	);
}

/** Why the policy is refused, or what its sections say. */
export function PolicySections({
	report,
	onServer = false,
}: {
	readonly report: GovernanceReport;
	readonly onServer?: boolean;
}): React.ReactElement {
	const { t, i18n } = useTranslation("settings");
	const governance = report.governance;
	const schedule = governance?.schedule ?? null;
	const budget = governance?.budget ?? null;
	const loop = governance?.loopDetection ?? null;
	const reviewers = governance?.files.reviewers ?? [];
	return (
		<>
			{report.errors.length > 0 && (
				<Notice tone="red" icon={ShieldAlert} role="alert">
					<p className="font-medium">{t("governance.invalid")}</p>
					<ul className="mt-1 list-disc pl-4 text-xs">
						{report.errors.map((e) => (
							<li key={e} className="break-words font-mono">
								{e}
							</li>
						))}
					</ul>
				</Notice>
			)}
			{!governance && report.errors.length === 0 && <p className="wp-muted text-sm">{t("governance.none")}</p>}
			{governance && (
				<div className="grid gap-3 md:grid-cols-4">
					<div className="space-y-1" data-testid="governance-schedule">
						<p className="wp-kicker flex items-center gap-1">
							<Clock className="h-3 w-3" aria-hidden="true" /> {t("governance.scheduleTitle")}
						</p>
						{schedule ? (
							<>
								<Chip tone={schedule.openNow ? "green" : "red"}>
									{t(schedule.openNow ? "governance.openNow" : "governance.closedNow")}
								</Chip>
								<p className="text-xs">
									{t("governance.scheduleLine", {
										hours: schedule.allowedHours.join(", "),
										timezone: schedule.timezone,
										days: schedule.days.join(", "),
									})}
								</p>
							</>
						) : (
							<p className="wp-muted text-xs">{t("governance.noSchedule")}</p>
						)}
					</div>
					<div className="space-y-1" data-testid="governance-files">
						<p className="wp-kicker flex items-center gap-1">
							<FileLock2 className="h-3 w-3" aria-hidden="true" /> {t("governance.filesTitle")}
						</p>
						<p className="text-xs font-medium">{t("governance.forbidden")}</p>
						<GlobList globs={governance.files.forbidden} empty={t("governance.noFiles")} />
						<p className="text-xs font-medium">{t("governance.requiresReview")}</p>
						<GlobList globs={governance.files.requiresReview} empty={t("governance.noFiles")} />
						{governance.files.requiresReview.length > 0 && (
							<p className="wp-muted text-xs" data-testid="governance-approver">
								{onServer
									? reviewers.length > 0
										? t("governance.serverReviewers", { roles: reviewers.join(", ") })
										: t("governance.serverApprover")
									: t("governance.localApprover")}
							</p>
						)}
					</div>
					<div className="space-y-1" data-testid="governance-budget">
						<p className="wp-kicker flex items-center gap-1">
							<Gauge className="h-3 w-3" aria-hidden="true" /> {t("governance.budgetTitle")}
						</p>
						{budget?.maxTokensPerHour ? (
							<p className="text-xs">
								{t("governance.budgetLine", {
									spent: report.tokensLastHour.toLocaleString(i18n.language),
									limit: budget.maxTokensPerHour.toLocaleString(i18n.language),
								})}
							</p>
						) : null}
						{budget?.maxTokensPerTask ? (
							<p className="text-xs">
								{t("governance.taskBudgetLine", {
									limit: budget.maxTokensPerTask.toLocaleString(i18n.language),
								})}
							</p>
						) : null}
						{!budget && <p className="text-xs">{t("governance.noBudget")}</p>}
					</div>
					<div className="space-y-1" data-testid="governance-loop">
						<p className="wp-kicker flex items-center gap-1">
							<Repeat className="h-3 w-3" aria-hidden="true" /> {t("governance.loopTitle")}
						</p>
						<p className="text-xs">
							{loop ? t("governance.loopLine", { count: loop.maxSameToolCall }) : t("governance.noLoop")}
						</p>
					</div>
				</div>
			)}
		</>
	);
}

export function MetricsChips({ metrics }: { readonly metrics: GovernanceMetrics }): React.ReactElement {
	const { t } = useTranslation("settings");
	return (
		<div data-testid="governance-metrics">
			<Chips>
				<Chip tone={metrics.blocked24h > 0 ? "red" : "muted"}>
					{t("governance.metricsBlocked", { count: metrics.blocked24h })}
				</Chip>
				<Chip tone={metrics.breakerTrips7d > 0 ? "amber" : "muted"}>
					{t("governance.metricsTrips", { count: metrics.breakerTrips7d })}
				</Chip>
			</Chips>
		</div>
	);
}

export function DecisionList({ events }: { readonly events: readonly PolicyAuditEvent[] }): React.ReactElement {
	const { t } = useTranslation("settings");
	return events.length > 0 ? (
		<ul className="grid gap-1.5" data-testid="governance-decisions">
			{events.slice(0, 20).map((event) => (
				<DecisionLine key={event.id} event={event} />
			))}
		</ul>
	) : (
		<p className="wp-muted text-sm">{t("governance.noDecisions")}</p>
	);
}
