/**
 * #3.4 CI/CD Anomaly Detective panel.
 *
 * Paste the log of one failed build, or of several builds: the detective
 * finds known failure patterns on every stack (npm, NuGet, Maven, Gradle,
 * Cargo, Composer, pub, Go, pip, Bundler, SwiftPM, runners) and, across
 * builds, the ones that recur. Each fix comes with a stable id the panel
 * words in the app's language.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { AnomalySignal } from "../../../preload/api/modules/phase35-features-api";
import { useCicdAnomalyStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PanelShell } from "./_panel-shell";

const SEV_COLOR: Record<AnomalySignal["severity"], string> = {
	critical: "bg-destructive/20 text-destructive border-destructive/40",
	high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
	medium: "bg-warning/20 text-warning border-warning/40",
	low: "bg-muted text-muted-foreground",
};

const LOG_MAX_LEN = 200_000;
const MAX_LOGS = 5;

export function CicdAnomalyPanel() {
	const { t } = useTranslation("phase35");
	const { phase, error, signals, report, analyse } = useCicdAnomalyStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			signals: s.signals,
			report: s.report,
			analyse: s.analyse,
		})),
	);
	const [logs, setLogs] = useState<string[]>([""]);

	const isRunning = phase === "running";
	const filled = logs.filter((l) => l.trim().length > 0);

	// Each box is cut at LOG_MAX_LEN as it is typed, so an empty form is the one mistake left.
	const logError = filled.length === 0 ? t("cicdAnomaly.validation.logRequired") : null;

	const fixText = (fixId: string | undefined, fallback: string) =>
		fixId ? t(`cicdAnomaly.fixes.${fixId}` as never, { defaultValue: fallback }) : fallback;
	const kindText = (kind: string) => t(`cicdAnomaly.kinds.${kind}` as never, { defaultValue: kind });
	const buildLabel = (index: number) => t("cicdAnomaly.buildLabel", { n: index + 1 });

	const run = () =>
		analyse(
			logs
				.map((text, i) => ({ label: buildLabel(i), text }))
				.filter((sample) => sample.text.trim().length > 0),
		);

	const recommendations = report?.recommendations ?? [];

	return (
		<PanelShell
			title={t("cicdAnomaly.title")}
			subtitle={t("cicdAnomaly.subtitle")}
			error={error}
			actions={
				<Button size="sm" onClick={run} disabled={isRunning || Boolean(logError)}>
					{isRunning ? t("common.running") : t("cicdAnomaly.scan")}
				</Button>
			}
		>
			<div className="space-y-3">
				<p className="text-xs text-muted-foreground">{t("cicdAnomaly.stacksNote")}</p>
				{logs.map((log, i) => (
					<div key={`log-${i.toString()}`}>
						<div className="mb-1 flex items-center justify-between">
							<label htmlFor={`log-textarea-${i}`} className="block text-sm font-medium">
								{logs.length > 1 ? buildLabel(i) : t("cicdAnomaly.logLabel")}
							</label>
							{logs.length > 1 && (
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setLogs(logs.filter((_, j) => j !== i))}
								>
									{t("cicdAnomaly.removeLog")}
								</Button>
							)}
						</div>
						<Textarea
							spellCheck={false}
							id={`log-textarea-${i}`}
							value={log}
							onChange={(e) =>
								setLogs(logs.map((l, j) => (j === i ? e.target.value.slice(0, LOG_MAX_LEN) : l)))
							}
							rows={logs.length > 1 ? 6 : 10}
							maxLength={LOG_MAX_LEN}
							aria-invalid={Boolean(logError) || undefined}
							aria-describedby={logError ? "log-error" : undefined}
							className="w-full p-2 text-xs font-mono min-h-0"
							placeholder={t("cicdAnomaly.logPlaceholder")}
						/>
					</div>
				))}
				<div className="flex items-center gap-3">
					<Button
						size="sm"
						variant="outline"
						onClick={() => setLogs([...logs, ""])}
						disabled={logs.length >= MAX_LOGS}
					>
						{t("cicdAnomaly.addLog")}
					</Button>
					<span className="text-xs text-muted-foreground">{t("cicdAnomaly.addLogHint")}</span>
				</div>
				{logError && (
					<p id="log-error" className="text-xs text-destructive">
						{logError}
					</p>
				)}

				{report && signals.length === 0 && (
					<p className="text-sm text-muted-foreground">{t("cicdAnomaly.noSignal")}</p>
				)}

				{report && report.recurring_kinds.length > 0 && (
					<div className="text-sm">
						<span className="font-medium">{t("cicdAnomaly.recurring")}</span>
						<span className="ml-2 inline-flex flex-wrap gap-1">
							{report.recurring_kinds.map((k) => (
								<Badge key={k} variant="outline">
									{kindText(k)}
								</Badge>
							))}
						</span>
					</div>
				)}

				{recommendations.length > 0 && (
					<div>
						<div className="mb-1 font-medium text-sm">{t("cicdAnomaly.recommendations")}</div>
						<ul className="ml-4 list-disc space-y-1 text-sm">
							{recommendations.map((r) => (
								<li key={`${r.kind}-${r.fix_id}`}>
									<span className="font-medium">{kindText(r.kind)}</span>
									{r.recurring && (
										<Badge variant="outline" className="ml-2 text-xs">
											{t("cicdAnomaly.recurringBadge")}
										</Badge>
									)}
									<span className="ml-2 text-muted-foreground">
										{fixText(r.fix_id, r.suggested_fix)}
									</span>
								</li>
							))}
						</ul>
					</div>
				)}

				{signals.length > 0 && (
					<div>
						<div className="mb-2 font-medium text-sm">
							{t("cicdAnomaly.signals")} ({signals.length})
						</div>
						<ul className="space-y-2 text-sm">
							{signals.map((s) => (
								<li
									key={`${s.log_label}-${s.kind}-${s.line_number}`}
									className="rounded border p-2"
								>
									<div className="flex flex-wrap items-center gap-2">
										<Badge className={SEV_COLOR[s.severity]}>
											{t(`common.severity.${s.severity}` as never, { defaultValue: s.severity })}
										</Badge>
										<span className="text-xs font-medium">{kindText(s.kind)}</span>
										<span className="text-xs text-muted-foreground">
											{logs.length > 1 && s.log_label
												? t("cicdAnomaly.lineIn", { label: s.log_label, line: s.line_number })
												: t("cicdAnomaly.lineAt", { line: s.line_number })}
										</span>
									</div>
									<div className="mt-1 font-mono text-xs text-muted-foreground truncate">
										{s.matching_line}
									</div>
									<div className="mt-1 text-xs">{fixText(s.fix_id, s.suggested_fix)}</div>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</PanelShell>
	);
}
