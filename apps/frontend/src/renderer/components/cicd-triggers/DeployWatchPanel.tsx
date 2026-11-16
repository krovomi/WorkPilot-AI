/**
 * The watch after a deployment, on a run of the CI/CD page (#366): the
 * verdict, the last sample, and the rollback (proposed, started, refused by a
 * migration, or by hand with a link to the last good run).
 */

import { AlertTriangle, ExternalLink, Undo2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeployWatch, DeployWatchLevel } from "../../../shared/types/deploy-watch";
import { CharterButton, Chip, Notice, type Tone } from "../charter";

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

interface DeployWatchPanelProps {
	readonly watch: DeployWatch;
	readonly busy: boolean;
	readonly onRollback: () => void;
}

export function DeployWatchPanel({ watch, busy, onRollback }: DeployWatchPanelProps): React.ReactElement {
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
							{t("cicdTriggers:watch.metric", {
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
			{watch.rollback === "started" && (
				<div className="wp-meta">{t("cicdTriggers:watch.revertHint")}</div>
			)}
			{canRollBack(watch) &&
				(confirming ? (
					<div className="flex flex-wrap items-center gap-2">
						<span>{t("cicdTriggers:watch.confirm")}</span>
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
