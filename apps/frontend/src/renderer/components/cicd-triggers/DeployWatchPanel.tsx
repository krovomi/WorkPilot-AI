/**
 * The watch after a deployment, on a run of the CI/CD page (#366): the
 * verdict, the last sample, and the rollback (proposed, started, refused by a
 * migration, or by hand with a link to the last good run); after a bad
 * verdict, the incident report, the revert PR of the deployed commit and
 * what became of the alerts (Slack, PagerDuty, e-mail). Lot 4: the linked
 * services the rollback takes back, a person's word on the verdict, and the
 * way to investigate (`DeployWatchExtras.tsx`).
 */

import { AlertTriangle, ExternalLink, GitPullRequest, Undo2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	DeployAlertChannel,
	DeployIncident,
	DeployRevertPr,
	DeployVerdictReview,
	DeployWatch,
	DeployWatchLevel,
} from "../../../shared/types/deploy-watch";
import { CharterButton, Chip, Notice, type Tone } from "../charter";
import { canReview, InvestigateLinks, LinkedRollbacks, VerdictReview } from "./DeployWatchExtras";

const VERDICT_TONES: Record<DeployWatchLevel, Tone> = {
	ok: "green",
	warning: "amber",
	critical: "red",
	unknown: "muted",
};

const RUNNING = new Set(["baseline", "waiting", "watching"]);

/** A person may roll back once the window has ended on a bad verdict. */
export function canRollBack(watch: DeployWatch): boolean {
	if (RUNNING.has(watch.phase)) return false;
	if (watch.verdict !== "warning" && watch.verdict !== "critical") return false;
	if (watch.rollback === "started" || watch.rollback === "manual") return false;
	return watch.plan?.automatic !== false;
}

export function isWatchRunning(watch: DeployWatch | undefined): boolean {
	return Boolean(watch && RUNNING.has(watch.phase));
}

function formatValue(value: number | null): string {
	return value === null ? "—" : String(Math.round(value * 1000) / 1000);
}

/** The revert PR is on the forge, with a link to it. */
export function revertOpened(revert: DeployRevertPr | undefined): boolean {
	return Boolean(revert?.url && (revert.status === "opened" || revert.status === "exists"));
}

function RevertPrLine({ revert }: { readonly revert: DeployRevertPr }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	if (revertOpened(revert)) {
		return (
			<a
				href={revert.url}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1 text-primary hover:underline"
				data-testid="deploy-revert-pr"
			>
				<GitPullRequest className="h-3 w-3" />
				{t("cicdTriggers:watch.revertPr.open", { sha: revert.sha.slice(0, 12) })}
			</a>
		);
	}
	const failed = revert.status !== "offline" && revert.status !== "unavailable";
	return (
		<div className={failed ? "text-destructive" : "wp-meta"} data-testid="deploy-revert-pr">
			{t(`cicdTriggers:watch.revertPr.${revert.status}`)}
		</div>
	);
}

function AlertsLine({ alerts }: { readonly alerts: NonNullable<DeployWatch["alerts"]> }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const entries = (Object.entries(alerts) as [DeployAlertChannel, string][]).map(([channel, status]) =>
		t(`cicdTriggers:watch.alerts.${status}`, { channel: t(`cicdTriggers:watch.alerts.channels.${channel}`) }),
	);
	return (
		<div className="wp-meta" data-testid="deploy-alerts">
			{t("cicdTriggers:watch.alerts.line", { list: entries.join(" · ") })}
		</div>
	);
}

function IncidentReport({ incident }: { readonly incident: DeployIncident }): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	return (
		<div className="space-y-0.5 rounded border border-border p-2" data-testid="deploy-incident">
			<div className="font-medium">{t("cicdTriggers:watch.incident.title")}</div>
			<div className="wp-meta">
				{t("cicdTriggers:watch.incident.samples", {
					critical: incident.criticalSamples,
					warning: incident.warningSamples,
				})}
				{incident.healthChecks > 0 &&
					` · ${t("cicdTriggers:watch.incident.health", {
						failed: incident.healthFailed,
						checks: incident.healthChecks,
					})}`}
			</div>
			{incident.metrics.length > 0 && (
				<ul className="space-y-0.5">
					{incident.metrics.map((m) => (
						<li key={m.name} className="wp-meta">
							{t("cicdTriggers:watch.incident.metric", {
								name: m.name,
								baseline: formatValue(m.baseline),
								worst: formatValue(m.worst),
								change: m.worstChangePct === null ? "—" : String(m.worstChangePct),
								level: t(`cicdTriggers:watch.verdict.${m.level}`),
							})}
						</li>
					))}
				</ul>
			)}
			{incident.explanation && (
				<p className="whitespace-pre-line">
					<span className="wp-meta">{t("cicdTriggers:watch.incident.explanation")} </span>
					{incident.explanation}
				</p>
			)}
		</div>
	);
}

interface DeployWatchPanelProps {
	readonly watch: DeployWatch;
	readonly busy: boolean;
	readonly onRollback: () => void;
	/** The projects a rollback of this one takes back with it. */
	readonly linkedNames?: readonly string[];
	readonly onReview?: (review: DeployVerdictReview | null) => void;
	/** The task whose PR this run deployed. */
	readonly taskId?: string;
}

/** The rollback stays with a person here: the linked services need one too. */
function linkedByHand(watch: DeployWatch, names: readonly string[]): boolean {
	return names.length > 0 && !watch.linked && (watch.rollback === "manual" || watch.rollback === "blocked_migrations");
}

export function DeployWatchPanel({
	watch,
	busy,
	onRollback,
	linkedNames = [],
	onReview,
	taskId,
}: DeployWatchPanelProps): React.ReactElement {
	const { t } = useTranslation(["cicdTriggers"]);
	const [confirming, setConfirming] = useState(false);

	if (watch.notConfigured) {
		return <div className="wp-meta mt-2">{t("cicdTriggers:watch.notConfigured")}</div>;
	}

	return (
		<div className="mt-2 space-y-1.5 text-xs" data-testid="deploy-watch">
			<div className="flex flex-wrap items-center gap-2">
				<Chip tone={VERDICT_TONES[watch.verdict]}>
					{t(`cicdTriggers:watch.verdict.${watch.verdict}`)}
				</Chip>
				<span className="wp-meta">
					{t(`cicdTriggers:watch.phase.${watch.phase}`)}
					{" · "}
					{t("cicdTriggers:watch.samples", { count: watch.samples })}
				</span>
				{watch.healthOk !== null && (
					<span className={watch.healthOk ? "text-success" : "text-destructive"}>
						{t(watch.healthOk ? "cicdTriggers:watch.healthOk" : "cicdTriggers:watch.healthFailed")}
					</span>
				)}
			</div>
			{watch.lastMetrics.length > 0 && (
				<ul className="space-y-0.5">
					{watch.lastMetrics.map((m) => (
						<li key={m.name} className="wp-meta">
							{t(m.canary ? "cicdTriggers:watch.metricCanary" : "cicdTriggers:watch.metric", {
								name: m.name,
								baseline: formatValue(m.baseline),
								current: formatValue(m.current),
								change: m.changePct === null ? "—" : String(m.changePct),
								level: t(`cicdTriggers:watch.verdict.${m.level}`),
							})}
						</li>
					))}
				</ul>
			)}
			{watch.problems.length > 0 && (
				<div className="wp-meta">
					{t("cicdTriggers:watch.problems", { problems: watch.problems.join(" · ") })}
				</div>
			)}
			{watch.migrations && watch.migrations.length > 0 && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("cicdTriggers:watch.migrations", { files: watch.migrations.join(", ") })}
				</Notice>
			)}
			{watch.rollback && (
				<div className={watch.rollback === "failed" ? "text-destructive" : "wp-meta"}>
					{t(`cicdTriggers:watch.rollback.${watch.rollback}`)}
					{watch.rollbackByPerson && <span className="ml-1">{t("cicdTriggers:watch.byPerson")}</span>}
					{watch.linkedCause && (
						<span className="ml-1">{t("cicdTriggers:watch.withProject", { project: watch.linkedCause })}</span>
					)}
				</div>
			)}
			{watch.linked && watch.linked.length > 0 && <LinkedRollbacks linked={watch.linked} />}
			{linkedByHand(watch, linkedNames) && (
				<div className="wp-meta">
					{t("cicdTriggers:watch.linkedByHand", { projects: linkedNames.join(", ") })}
				</div>
			)}
			{watch.plan && !watch.plan.automatic && (
				<div className="wp-meta">{t(`cicdTriggers:watch.plan.${watch.plan.reason}`, { defaultValue: "" })}</div>
			)}
			{watch.plan?.targetUrl && (
				<a
					href={watch.plan.targetUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-primary hover:underline"
				>
					<ExternalLink className="h-3 w-3" />
					{t("cicdTriggers:watch.openTarget", { run: watch.plan.targetRun })}
				</a>
			)}
			{watch.incident && <IncidentReport incident={watch.incident} />}
			{watch.incident && <InvestigateLinks taskId={taskId} />}
			{watch.revertPr && <RevertPrLine revert={watch.revertPr} />}
			{watch.alerts && <AlertsLine alerts={watch.alerts} />}
			{watch.rollback === "started" && !revertOpened(watch.revertPr) && (
				<div className="wp-meta">{t("cicdTriggers:watch.revertHint")}</div>
			)}
			{onReview && canReview(watch) && <VerdictReview watch={watch} onReview={onReview} />}
			{canRollBack(watch) &&
				(confirming ? (
					<div className="flex flex-wrap items-center gap-2">
						<span>
							{linkedNames.length > 0
								? t("cicdTriggers:watch.confirmLinked", { projects: linkedNames.join(", ") })
								: t("cicdTriggers:watch.confirm")}
						</span>
						<CharterButton
							size="sm"
							variant="danger"
							icon={Undo2}
							busy={busy}
							onClick={() => {
								setConfirming(false);
								onRollback();
							}}
						>
							{t("cicdTriggers:watch.confirmButton")}
						</CharterButton>
						<CharterButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
							{t("cicdTriggers:watch.cancel")}
						</CharterButton>
					</div>
				) : (
					<CharterButton
						size="sm"
						variant="default"
						icon={Undo2}
						busy={busy}
						disabled={busy}
						onClick={() => setConfirming(true)}
					>
						{t("cicdTriggers:watch.rollbackButton")}
					</CharterButton>
				))}
		</div>
	);
}
