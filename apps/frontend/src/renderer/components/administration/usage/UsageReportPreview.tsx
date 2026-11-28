/**
 * The usage report of one day, week or month, as the email carries it
 * (`GET /admin/usage/report`, `usage.read`): readable here even when the
 * server cannot send mail. People appear by name only when the report names
 * them; the server leaves the name out otherwise.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageReport, UsageReportKind } from "@shared/types/server-usage";
import { Button, DateField, Label, NativeSelect } from "@/components/ui";
import { formatCount, formatDay, formatRate, formatTokens, formatUsd } from "./usage-format";

const KINDS: readonly UsageReportKind[] = ["daily", "weekly", "monthly"];

/** A figure of the report in its own unit; a dash when there is none. */
export function formatFigure(name: string, value: number | null): string {
	if (value === null) return "–";
	if (name === "tokens") return formatTokens(value);
	if (name.endsWith("_usd")) return formatUsd(value);
	if (name === "success_rate") return formatRate(value);
	return formatCount(value);
}

/** A budget's share (0 to 100 and over) as a percent. */
function percent(value: number): string {
	return formatRate(value / 100);
}

function ReportBody({ report }: { readonly report: UsageReport }) {
	const { t } = useTranslation("administration");
	const figures = Object.entries(report.figures);
	const daily = report.kind === "daily";
	return (
		<div className="space-y-4">
			<p className="text-sm">
				{t("usage.report.preview.period", {
					start: formatDay(report.start),
					end: formatDay(report.end),
				})}
			</p>
			<table className="w-full text-sm">
				<thead className="text-left text-xs text-muted-foreground">
					<tr>
						<th className="py-1 font-medium">{t("usage.report.preview.figure")}</th>
						<th className="py-1 text-right font-medium">{t("usage.report.preview.value")}</th>
						<th className="py-1 text-right font-medium">{t("usage.report.preview.previous")}</th>
						{daily && (
							<th className="py-1 text-right font-medium">{t("usage.report.preview.average")}</th>
						)}
					</tr>
				</thead>
				<tbody>
					{figures.map(([name, figure]) => (
						<tr key={name} className="border-t border-border">
							<td className="py-1">
								{t(`usage.report.preview.figures.${name}`, { defaultValue: name })}
							</td>
							<td className="py-1 text-right">{formatFigure(name, figure.value)}</td>
							<td className="py-1 text-right">{formatFigure(name, figure.previous)}</td>
							{daily && <td className="py-1 text-right">{formatFigure(name, figure.average)}</td>}
						</tr>
					))}
				</tbody>
			</table>
			{report.dormant > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("usage.report.preview.dormant", { count: report.dormant })}
				</p>
			)}
			{report.alerts.length > 0 && (
				<div className="space-y-1">
					<h4 className="text-xs font-semibold">{t("usage.report.preview.alerts")}</h4>
					{report.alerts.map((alert) => (
						<p key={`${alert.kind}-${alert.scope}-${alert.name}`} className="text-xs text-warning">
							{alert.kind === "budget"
								? t("usage.report.preview.budgetAlert", {
										percent: percent(alert.percent),
										threshold: alert.threshold,
									})
								: t("usage.report.preview.scopeAlert", {
										scope: t(`usage.budgets.scopes.${alert.scope}`, {
											defaultValue: alert.scope,
										}),
										name: alert.name ?? t("usage.report.preview.unnamed"),
										percent: percent(alert.percent),
										threshold: alert.threshold,
									})}
						</p>
					))}
				</div>
			)}
			{report.top.length > 0 && (
				<div className="space-y-1">
					<h4 className="text-xs font-semibold">{t("usage.report.preview.top")}</h4>
					<table className="w-full text-sm">
						<tbody>
							{report.top.map((person, index) => (
								<tr key={`${index}-${person.tokens}`} className="border-t border-border">
									<td className="py-1">{person.name ?? t("usage.report.preview.unnamed")}</td>
									<td className="py-1 text-right">{formatTokens(person.tokens)}</td>
									<td className="py-1 text-right">{formatUsd(person.cost_usd)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{report.engines.length > 0 && (
				<div className="space-y-1">
					<h4 className="text-xs font-semibold">{t("usage.dashboard.modelsTitle")}</h4>
					<table className="w-full text-sm">
						<tbody>
							{report.engines.map((engine) => (
								<tr key={`${engine.provider}/${engine.model}`} className="border-t border-border">
									<td className="py-1">
										{engine.provider || t("usage.dashboard.unknownProvider")}
										<span className="ml-2 text-muted-foreground">{engine.model}</span>
									</td>
									<td className="py-1 text-right">{formatTokens(engine.tokens)}</td>
									<td className="py-1 text-right">{formatUsd(engine.cost_usd)}</td>
									<td className="py-1 text-right">{formatCount(engine.runs)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{report.failures.length > 0 && (
				<div className="space-y-1">
					<h4 className="text-xs font-semibold">{t("usage.dashboard.failures")}</h4>
					{report.failures.map((failure) => (
						<p key={failure.cause} className="text-xs">
							{t(`usage.dashboard.causes.${failure.cause}`, { defaultValue: failure.cause })}
							<span className="ml-2 text-muted-foreground">
								{t("usage.dashboard.failureCounts", { runs: failure.runs, jobs: failure.jobs })}
							</span>
						</p>
					))}
				</div>
			)}
		</div>
	);
}

export function UsageReportPreview() {
	const { t } = useTranslation("administration");
	const [kind, setKind] = useState<UsageReportKind>("daily");
	const [day, setDay] = useState("");
	const [report, setReport] = useState<UsageReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const show = useCallback(async (asked: UsageReportKind, holding: string) => {
		const bridge = globalThis.electronAPI?.serverUsage;
		if (!bridge) return;
		setLoading(true);
		setError(null);
		const result = await bridge.getReport(asked, holding || undefined);
		setLoading(false);
		if (result.ok) setReport(result.data);
		else {
			setReport(null);
			setError(result.error);
		}
	}, []);

	useEffect(() => {
		void show("daily", "");
	}, [show]);

	return (
		<section className="space-y-3">
			<div>
				<h3 className="text-sm font-semibold">{t("usage.report.preview.title")}</h3>
				<p className="text-xs text-muted-foreground">{t("usage.report.preview.hint")}</p>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<Label htmlFor="report-kind">{t("usage.report.kind")}</Label>
					<NativeSelect
						id="report-kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as UsageReportKind)}
					>
						{KINDS.map((k) => (
							<option key={k} value={k}>
								{t(`usage.report.kinds.${k}`)}
							</option>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-1">
					<Label htmlFor="report-day">{t("usage.report.preview.day")}</Label>
					<DateField id="report-day" value={day} onValueChange={setDay} />
				</div>
				<Button variant="outline" disabled={loading} onClick={() => void show(kind, day)}>
					{t("usage.report.preview.show")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error })}
				</p>
			)}
			{report && <ReportBody report={report} />}
		</section>
	);
}
