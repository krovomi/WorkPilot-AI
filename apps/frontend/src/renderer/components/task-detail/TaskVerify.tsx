import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../shared/types";
import { type VerifyRecord, verifyScreenshotUrl } from "../../lib/agent-tools-api";
import { useVerifyStore } from "../../stores/verify-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { measured, statusVariant } from "./verify-view";

export interface TaskVerifyProps {
	readonly task: Task;
	readonly projectPath?: string;
}

/**
 * L'onglet « Vérification » : tout ce que la boucle a mesuré.
 *
 * Dans l'ordre où la boucle l'a fait — lancement et erreurs, tours de
 * correction, état confirmé, endpoints, performance, captures, scénario —
 * parce que c'est l'ordre dans lequel on relit une preuve. Le texte affiché
 * vient de l'application (journaux, réponses, pages) : c'est une donnée,
 * rendue comme du texte.
 *
 * L'onglet n'est proposé que quand un enregistrement existe
 * (`hasVerifyRecord`), comme celui de l'architecture.
 */
export function TaskVerify({ task, projectPath }: TaskVerifyProps) {
	const { t } = useTranslation(["tasks"]);
	const run = useVerifyStore((s) => s.run);
	const entry = useVerifyStore((s) => s.byTask[task.id]);
	const record = entry?.data?.record ?? null;
	if (!projectPath || !record) {
		return <p className="p-4 text-sm text-muted-foreground">{t("tasks:verify.empty")}</p>;
	}
	const query = { projectDir: projectPath, specId: task.specId };
	const running = entry?.busy === "running";

	return (
		<div className="space-y-5 p-4 text-sm">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant={statusVariant(record.status)}>
						{t(`tasks:verify.status.${record.status}`)}
					</Badge>
					{measured(record.score) !== null && (
						<span className="text-muted-foreground">
							{t("tasks:verify.badge.score", { score: measured(record.score) })}
						</span>
					)}
					{record.reason && <span className="text-muted-foreground">{record.reason}</span>}
				</div>
				<div className="flex gap-2">
					<Button size="sm" variant="outline" disabled={running} onClick={() => void run(task.id, query, "low")}>
						{t("tasks:verify.rerunQuick")}
					</Button>
					<Button size="sm" disabled={running} onClick={() => void run(task.id, query)}>
						{running && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
						{t("tasks:verify.rerun")}
					</Button>
				</div>
			</header>

			<Targets record={record} />
			<Rounds record={record} />
			<Confirmations record={record} />
			<Endpoints record={record} />
			<Performance record={record} />
			<Mobile record={record} />
			<Screenshots record={record} query={query} />
			<Scenario record={record} />
			<Findings record={record} />
			{record.browser?.reasons && record.browser.reasons.length > 0 && !record.browser.engine && (
				<p className="text-xs text-muted-foreground">
					{t("tasks:verify.noBrowser", { reasons: record.browser.reasons.join(" · ") })}
				</p>
			)}
		</div>
	);
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
	return (
		<section>
			<h4 className="mb-2 font-medium">{title}</h4>
			{children}
		</section>
	);
}

function Targets({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.targets.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.launch")}>
			<ul className="space-y-2">
				{record.targets.map((target) => (
					<li key={target.name} className="rounded border border-border p-2">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{target.name}</span>
							<Badge variant="outline" className="text-[10px]">
								{t(`tasks:verify.kind.${target.kind}`, { defaultValue: target.kind })}
							</Badge>
							<Badge
								variant={target.launch?.status === "ready" || target.launch?.status === "reused" ? "outline" : "destructive"}
								className="text-[10px]"
							>
								{t(`tasks:verify.launch.${target.launch?.status ?? "unknown"}`, {
									defaultValue: target.launch?.status ?? "?",
								})}
							</Badge>
							{target.origin === "recipe" && (
								<Badge variant="secondary" className="text-[10px]">
									{t("tasks:verify.learnedRecipe")}
								</Badge>
							)}
						</div>
						{target.launch?.command && (
							<code className="mt-1 block truncate text-xs text-muted-foreground">{target.launch.command}</code>
						)}
						{target.errors.length > 0 ? (
							<ul className="mt-1 space-y-0.5 text-xs text-destructive">
								{target.errors.slice(0, 10).map((error) => (
									<li key={`${error.kind}|${error.message}|${error.file}`}>
										[{error.kind}] {error.message}
										{error.file ? ` — ${error.file}:${error.line ?? "?"}` : ""}
									</li>
								))}
							</ul>
						) : (
							<p className="mt-1 text-xs text-muted-foreground">{t("tasks:verify.noErrors")}</p>
						)}
					</li>
				))}
			</ul>
		</Section>
	);
}

function Rounds({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.rounds.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.rounds")}>
			<ol className="space-y-1 text-xs">
				{record.rounds.map((round) => (
					<li key={`${round.target}-${round.round}`} className="flex flex-wrap gap-2">
						<span className="font-medium">{t("tasks:verify.round", { round: round.round })}</span>
						<span>
							{t("tasks:verify.roundErrors", {
								before: round.errors_before,
								after: round.errors_after ?? "?",
							})}
						</span>
						{round.note && <span className="text-muted-foreground">{round.note}</span>}
					</li>
				))}
			</ol>
		</Section>
	);
}

function Confirmations({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.confirmations.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.confirmed")}>
			<ul className="space-y-1 text-xs">
				{record.confirmations.map((item) => (
					<li key={`${item.state}|${item.evidence}`}>
						<span className="font-medium">{item.state}</span>
						{item.evidence && (
							<span className="text-muted-foreground"> — {t("tasks:verify.evidence", { evidence: item.evidence })}</span>
						)}
					</li>
				))}
			</ul>
		</Section>
	);
}

function Endpoints({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.endpoints.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.endpoints")}>
			<div className="overflow-x-auto">
				<table className="w-full text-left text-xs">
					<thead className="text-muted-foreground">
						<tr>
							<th className="py-1 pr-3">{t("tasks:verify.table.call")}</th>
							<th className="py-1 pr-3">{t("tasks:verify.table.expected")}</th>
							<th className="py-1 pr-3">{t("tasks:verify.table.got")}</th>
							<th className="py-1 pr-3">{t("tasks:verify.table.schema")}</th>
							<th className="py-1">{t("tasks:verify.table.latency")}</th>
						</tr>
					</thead>
					<tbody>
						{record.endpoints.map((call, index) => (
							<tr
								// biome-ignore lint/suspicious/noArrayIndexKey: the same call can legitimately appear twice
								key={`${call.method}-${call.path}-${index}`}
								className={call.ok ? "" : call.outcome === "called" ? "text-destructive" : "text-muted-foreground"}
								title={call.problems?.join("\n") || call.note || ""}
							>
								<td className="py-1 pr-3 font-mono">
									{call.method} {call.path}
								</td>
								<td className="py-1 pr-3">{call.expected?.length ? call.expected.join(", ") : "2xx"}</td>
								<td className="py-1 pr-3">
									{call.status ?? t(`tasks:verify.outcome.${call.outcome}`, { defaultValue: call.outcome })}
								</td>
								<td className="py-1 pr-3">
									{call.schema_ok === null || call.schema_ok === undefined
										? t("tasks:verify.notMeasured")
										: call.schema_ok
											? t("tasks:verify.schemaOk")
											: t("tasks:verify.schemaKo")}
								</td>
								<td className="py-1">
									{measured(call.latency_ms) !== null
										? t("tasks:verify.ms", { value: measured(call.latency_ms) })
										: t("tasks:verify.notMeasured")}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{record.latency?.count ? (
				<p className="mt-1 text-xs text-muted-foreground">
					{t("tasks:verify.latency", {
						p50: measured(record.latency.p50_ms),
						p95: measured(record.latency.p95_ms),
						count: record.latency.count,
					})}
				</p>
			) : null}
		</Section>
	);
}

function Metric({ label, value }: { readonly label: string; readonly value: string | null }) {
	const { t } = useTranslation(["tasks"]);
	return (
		<div className="rounded border border-border p-2">
			<div className="text-[10px] uppercase text-muted-foreground">{label}</div>
			<div className={value === null ? "text-xs italic text-muted-foreground" : "font-medium"}>
				{value ?? t("tasks:verify.notMeasured")}
			</div>
		</div>
	);
}

function Performance({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	const lighthouse = Object.entries(record.lighthouse ?? {});
	if (record.perf.length === 0 && lighthouse.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.performance")}>
			<div className="space-y-3">
				{record.perf.map((perf) => (
					<div key={perf.url}>
						<p className="mb-1 truncate text-xs text-muted-foreground">
							{perf.url} · {perf.engine || "—"}
						</p>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
							<Metric label={t("tasks:verify.metrics.score")} value={measured(perf.score)} />
							<Metric label="LCP" value={measured(perf.lcp_ms) && t("tasks:verify.ms", { value: measured(perf.lcp_ms) })} />
							<Metric label="CLS" value={measured(perf.cls, 3)} />
							<Metric label="TBT" value={measured(perf.tbt_ms) && t("tasks:verify.ms", { value: measured(perf.tbt_ms) })} />
							<Metric label="FCP" value={measured(perf.fcp_ms) && t("tasks:verify.ms", { value: measured(perf.fcp_ms) })} />
						</div>
						{perf.scored_on?.length > 0 && (
							<p className="mt-1 text-[11px] text-muted-foreground">
								{t("tasks:verify.scoredOn", { metrics: perf.scored_on.join(", ") })}
							</p>
						)}
						{!perf.measured && perf.reason && (
							<p className="mt-1 text-[11px] text-muted-foreground">{perf.reason}</p>
						)}
					</div>
				))}
				{lighthouse.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{lighthouse.map(([category, score]) => (
							<Badge key={category} variant="outline" className="text-[10px]">
								{t(`tasks:verify.lighthouse.${category}`, { defaultValue: category })}: {score}
							</Badge>
						))}
					</div>
				)}
			</div>
		</Section>
	);
}

function Mobile({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.mobile.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.mobile")}>
			<ul className="space-y-1 text-xs">
				{record.mobile.map((item) => (
					<li key={item.platform}>
						<span className="font-medium">{item.platform}</span> — {t(`tasks:verify.mobileStatus.${item.status}`, { defaultValue: item.status })}
						{item.device ? ` · ${item.device}` : ""}
						{measured(item.startup_ms) !== null && ` · ${t("tasks:verify.startup", { value: measured(item.startup_ms) })}`}
						{item.detail ? <span className="text-muted-foreground"> · {item.detail}</span> : null}
					</li>
				))}
			</ul>
		</Section>
	);
}

function Screenshots({
	record,
	query,
}: {
	readonly record: VerifyRecord;
	readonly query: { projectDir: string; specId: string };
}) {
	const { t } = useTranslation(["tasks"]);
	if (record.screenshots.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.screenshots")}>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{record.screenshots.map((shot) => (
					<figure key={shot.index} className="overflow-hidden rounded border border-border">
						<img
							src={verifyScreenshotUrl(query, shot.index)}
							alt={shot.label || t("tasks:verify.screenshotAlt")}
							className="block w-full bg-background object-contain"
							loading="lazy"
						/>
						<figcaption className="px-2 py-1 text-[11px] text-muted-foreground">{shot.label}</figcaption>
					</figure>
				))}
			</div>
		</Section>
	);
}

function Scenario({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.scenario.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.scenario")}>
			<ol className="list-decimal space-y-0.5 pl-5 text-xs">
				{record.scenario.map((step, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered log, repeats included
					<li key={index}>
						<span className="font-mono">{step.action}</span>{" "}
						<span className="text-muted-foreground">{step.text || step.url || step.value || step.note || ""}</span>
					</li>
				))}
			</ol>
		</Section>
	);
}

function Findings({ record }: { readonly record: VerifyRecord }) {
	const { t } = useTranslation(["tasks"]);
	if (record.findings.length === 0) return null;
	return (
		<Section title={t("tasks:verify.sections.findings")}>
			<ul className="space-y-1 text-xs">
				{record.findings.map((finding) => (
					<li key={finding.message}>
						<Badge variant={finding.severity === "high" ? "destructive" : "outline"} className="mr-2 text-[10px]">
							{finding.severity}
						</Badge>
						{finding.message}
					</li>
				))}
			</ul>
		</Section>
	);
}
