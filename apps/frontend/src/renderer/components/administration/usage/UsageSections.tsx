/**
 * The Usage tab's sections, each drawn from one view the server computed
 * (`server/services/usage_report.py`, `usage_delivery.py`). Display only:
 * names, totals and action names, as the server sends them.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageDailyRow,
	UsageDelivery,
	UsageExport,
	UsageModels,
	UsagePages,
	UsagePersonRow,
	UsagePresence,
	UsageProjectRow,
	UsageSummary,
} from "@shared/types/server-usage";
import { Button, Card, CardContent } from "@/components/ui";
import { formatAppDateTime, formatAppDay } from "@/lib/date-format";
import type { Loaded } from "./use-usage-view";
import { formatCount, formatRate, formatTokens, formatUsd } from "./usage-format";

/** Series colours of the per-day chart, one per provider in turn. */
const SERIES = [
	"bg-primary",
	"bg-info",
	"bg-success",
	"bg-warning",
	"bg-destructive",
	"bg-muted-foreground",
];

export function Section({
	title,
	exportAs,
	onExport,
	children,
}: {
	readonly title: string;
	readonly exportAs?: UsageExport;
	readonly onExport?: (view: UsageExport) => void;
	readonly children: ReactNode;
}) {
	const { t } = useTranslation("administration");
	return (
		<section className="space-y-3 rounded-md border border-border p-4">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-semibold">{title}</h3>
				{exportAs && onExport && (
					<Button size="sm" variant="outline" onClick={() => onExport(exportAs)}>
						{t("usage.dashboard.exportCsv")}
					</Button>
				)}
			</div>
			{children}
		</section>
	);
}

/** A view's content once loaded, its error, or a loading line. */
export function Shown<T>({
	loaded,
	children,
}: {
	readonly loaded: Loaded<T>;
	readonly children: (data: T) => ReactNode;
}) {
	const { t } = useTranslation("administration");
	if (loaded.error) {
		return (
			<p role="alert" className="text-sm text-destructive">
				{t("usage.failed", { error: loaded.error })}
			</p>
		);
	}
	if (!loaded.data) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
	return <>{children(loaded.data)}</>;
}

function Empty() {
	const { t } = useTranslation("administration");
	return <p className="text-xs text-muted-foreground">{t("usage.dashboard.empty")}</p>;
}

function Figure({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }) {
	return (
		<Card>
			<CardContent className="p-4">
				<div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
				<div className="mt-1 text-xl font-bold">{value}</div>
				{hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
			</CardContent>
		</Card>
	);
}

export function KeyFigures({ summary }: { readonly summary: UsageSummary }) {
	const { t } = useTranslation("administration");
	const budget = summary.budget;
	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<Figure
				label={t("usage.dashboard.tokens")}
				value={formatTokens(summary.tokens.total)}
				hint={t("usage.dashboard.tokensHint", {
					input: formatTokens(summary.tokens.input),
					output: formatTokens(summary.tokens.output),
				})}
			/>
			<Figure
				label={t("usage.dashboard.cost")}
				value={formatUsd(summary.cost_usd)}
				hint={summary.estimated ? t("usage.dashboard.estimated") : undefined}
			/>
			<Figure
				label={t("usage.dashboard.budget")}
				value={budget?.percent === null || !budget ? "–" : `${budget.percent} %`}
				hint={
					budget?.monthly_token_budget
						? t("usage.dashboard.budgetHint", {
								used: formatTokens(budget.used_this_month),
								limit: formatTokens(budget.monthly_token_budget),
							})
						: t("usage.dashboard.noBudget")
				}
			/>
			<Figure
				label={t("usage.dashboard.active")}
				value={formatCount(summary.active.day)}
				hint={t("usage.dashboard.activeHint", {
					week: summary.active.week,
					month: summary.active.month,
				})}
			/>
			<Figure
				label={t("usage.dashboard.runs")}
				value={formatCount(summary.runs.total)}
				hint={t("usage.dashboard.successRate", { rate: formatRate(summary.runs.success_rate) })}
			/>
			<Figure
				label={t("usage.dashboard.jobs")}
				value={formatCount(summary.jobs.total)}
				hint={t("usage.dashboard.successRate", { rate: formatRate(summary.jobs.success_rate) })}
			/>
			<Figure label={t("usage.dashboard.sessions")} value={formatCount(summary.sessions)} />
		</div>
	);
}

/** Tokens per day, stacked by provider; drawn with plain divs, like the overview. */
export function DailyChart({ rows }: { readonly rows: readonly UsageDailyRow[] }) {
	const { t } = useTranslation("administration");
	if (rows.length === 0) return <Empty />;
	const providers = [...new Set(rows.map((r) => r.provider))].sort();
	const days = [...new Set(rows.map((r) => r.day))].sort();
	const total = (day: string) =>
		rows.filter((r) => r.day === day).reduce((sum, r) => sum + r.tokens, 0);
	const max = Math.max(1, ...days.map(total));
	const colour = (provider: string) => SERIES[providers.indexOf(provider) % SERIES.length];
	return (
		<div className="space-y-2">
			<div
				className="flex h-36 items-end gap-1"
				role="img"
				aria-label={t("usage.dashboard.dailyChart")}
			>
				{days.map((day) => (
					<div key={day} className="flex h-full flex-1 flex-col justify-end" title={formatAppDay(day)}>
						{providers.map((provider) => {
							const row = rows.find((r) => r.day === day && r.provider === provider);
							if (!row || row.tokens === 0) return null;
							return (
								<div
									key={provider}
									className={`w-full ${colour(provider)}`}
									style={{ height: `${(row.tokens / max) * 100}%` }}
									title={`${formatAppDay(day)} · ${provider || "?"} · ${formatTokens(row.tokens)} · ${formatUsd(row.cost_usd)}`}
								/>
							);
						})}
					</div>
				))}
			</div>
			<ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
				{providers.map((provider) => (
					<li key={provider} className="flex items-center gap-1">
						<span className={`inline-block h-2 w-2 rounded-full ${colour(provider)}`} />
						{provider || t("usage.dashboard.unknownProvider")}
					</li>
				))}
			</ul>
		</div>
	);
}

function Table({ head, children }: { readonly head: readonly string[]; readonly children: ReactNode }) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						{head.map((h) => (
							<th key={h} className="px-2 py-1 font-medium">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

const cell = "px-2 py-1";

export function PeopleTable({
	rows,
	onOpen,
}: {
	readonly rows: readonly UsagePersonRow[];
	readonly onOpen: (personId: string) => void;
}) {
	const { t } = useTranslation("administration");
	if (rows.length === 0) return <Empty />;
	return (
		<Table
			head={[
				t("usage.dashboard.person"),
				t("usage.dashboard.runs"),
				t("usage.dashboard.jobs"),
				t("usage.dashboard.tokens"),
				t("usage.dashboard.cost"),
				t("usage.dashboard.engines"),
				t("usage.dashboard.lastSeen"),
			]}
		>
			{rows.map((row) => (
				<tr key={row.user_id ?? "erased"} className="border-b border-border/50">
					<td className={cell}>
						{row.user_id ? (
							<button
								type="button"
								className="text-left text-primary hover:underline"
								onClick={() => onOpen(row.user_id as string)}
							>
								{row.name ?? row.email}
							</button>
						) : (
							<span className="italic text-muted-foreground">{t("usage.dashboard.erased")}</span>
						)}
					</td>
					<td className={cell}>{formatCount(row.runs)}</td>
					<td className={cell}>{formatCount(row.jobs)}</td>
					<td className={cell}>{formatTokens(row.tokens)}</td>
					<td className={cell}>{formatUsd(row.cost_usd)}</td>
					<td className={`${cell} text-xs text-muted-foreground`}>{row.models.join(", ")}</td>
					<td className={`${cell} text-xs text-muted-foreground`}>
						{row.last_seen_at ? formatAppDateTime(row.last_seen_at) : "–"}
					</td>
				</tr>
			))}
		</Table>
	);
}

export function ModelsTables({ report }: { readonly report: UsageModels }) {
	const { t } = useTranslation("administration");
	if (report.models.length === 0) return <Empty />;
	const head = [
		t("usage.dashboard.provider"),
		t("usage.dashboard.model"),
		t("usage.dashboard.runs"),
		t("usage.dashboard.successRateShort"),
		t("usage.dashboard.tokens"),
		t("usage.dashboard.cost"),
		t("usage.dashboard.costPerRun"),
	];
	return (
		<div className="space-y-4">
			<Table head={head}>
				{report.models.map((row) => (
					<tr key={`${row.provider}/${row.model}`} className="border-b border-border/50">
						<td className={cell}>{row.provider}</td>
						<td className={cell}>{row.model}</td>
						<td className={cell}>{formatCount(row.runs)}</td>
						<td className={cell}>{formatRate(row.success_rate)}</td>
						<td className={cell}>{formatTokens(row.tokens)}</td>
						<td className={cell}>{formatUsd(row.cost_usd)}</td>
						<td className={cell}>
							{row.cost_per_run_usd === null ? "–" : formatUsd(row.cost_per_run_usd)}
						</td>
					</tr>
				))}
			</Table>
			<h4 className="text-xs font-semibold text-muted-foreground">{t("usage.dashboard.byPhase")}</h4>
			<Table head={[t("usage.dashboard.phase"), ...head]}>
				{report.phases.map((row) => (
					<tr
						key={`${row.phase}/${row.provider}/${row.model}`}
						className="border-b border-border/50"
					>
						<td className={cell}>{row.phase}</td>
						<td className={cell}>{row.provider}</td>
						<td className={cell}>{row.model}</td>
						<td className={cell}>{formatCount(row.runs)}</td>
						<td className={cell}>{formatRate(row.success_rate)}</td>
						<td className={cell}>{formatTokens(row.tokens)}</td>
						<td className={cell}>{formatUsd(row.cost_usd)}</td>
						<td className={cell}>
							{row.cost_per_run_usd === null ? "–" : formatUsd(row.cost_per_run_usd)}
						</td>
					</tr>
				))}
			</Table>
		</div>
	);
}

export function ProjectsTable({ rows }: { readonly rows: readonly UsageProjectRow[] }) {
	const { t } = useTranslation("administration");
	if (rows.length === 0) return <Empty />;
	return (
		<Table
			head={[
				t("usage.dashboard.project"),
				t("usage.dashboard.runs"),
				t("usage.dashboard.tokens"),
				t("usage.dashboard.cost"),
				t("usage.dashboard.phases"),
			]}
		>
			{rows.map((row) => (
				<tr key={row.project_id ?? "none"} className="border-b border-border/50">
					<td className={cell}>{row.name ?? t("usage.dashboard.noProject")}</td>
					<td className={cell}>{formatCount(row.runs)}</td>
					<td className={cell}>{formatTokens(row.tokens)}</td>
					<td className={cell}>{formatUsd(row.cost_usd)}</td>
					<td className={`${cell} text-xs text-muted-foreground`}>
						{row.phases.map((p) => `${p.phase} ${formatUsd(p.cost_usd)}`).join(" · ")}
					</td>
				</tr>
			))}
		</Table>
	);
}

export function PagesTable({ report }: { readonly report: UsagePages }) {
	const { t } = useTranslation("administration");
	return (
		<div className="space-y-2">
			{report.enabled === false && (
				<p className="text-xs text-muted-foreground">{t("usage.dashboard.pagesOff")}</p>
			)}
			{report.pages.length === 0 ? (
				<Empty />
			) : (
				<Table
					head={[
						t("usage.dashboard.app"),
						t("usage.dashboard.page"),
						t("usage.dashboard.opens"),
						t("usage.dashboard.people"),
					]}
				>
					{report.pages.map((row) => (
						<tr key={`${row.client}/${row.page}`} className="border-b border-border/50">
							<td className={cell}>{t(`usage.dashboard.apps.${row.client}`)}</td>
							<td className={`${cell} font-mono text-xs`}>{row.page}</td>
							<td className={cell}>{formatCount(row.opens)}</td>
							<td className={cell}>{formatCount(row.people)}</td>
						</tr>
					))}
				</Table>
			)}
		</div>
	);
}

const FUNNEL = ["invited", "accepted", "first_sign_in", "first_task", "first_merge"] as const;

export function DeliverySection({ report }: { readonly report: UsageDelivery }) {
	const { t } = useTranslation("administration");
	const top = Math.max(1, ...FUNNEL.map((step) => report.funnel[step]));
	const { delivered } = report;
	return (
		<div className="grid gap-4 lg:grid-cols-3">
			<div className="space-y-2">
				<h4 className="text-xs font-semibold text-muted-foreground">{t("usage.dashboard.funnel")}</h4>
				{FUNNEL.map((step) => (
					<div key={step} className="space-y-0.5">
						<div className="flex justify-between text-xs">
							<span>{t(`usage.dashboard.funnelSteps.${step}`)}</span>
							<span>{formatCount(report.funnel[step])}</span>
						</div>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary"
								style={{ width: `${(report.funnel[step] / top) * 100}%` }}
							/>
						</div>
					</div>
				))}
			</div>
			<div className="space-y-1 text-sm">
				<h4 className="text-xs font-semibold text-muted-foreground">{t("usage.dashboard.delivered")}</h4>
				<p>{t("usage.dashboard.deliveredTasks", { count: delivered.tasks })}</p>
				<p>
					{t("usage.dashboard.costPerTask", {
						cost: delivered.cost_per_task_usd === null ? "–" : formatUsd(delivered.cost_per_task_usd),
					})}
				</p>
				<p>
					{t("usage.dashboard.timeToMerge", {
						hours: delivered.median_hours_to_merge ?? "–",
					})}
				</p>
			</div>
			<div className="space-y-1 text-sm">
				<h4 className="text-xs font-semibold text-muted-foreground">{t("usage.dashboard.failures")}</h4>
				{report.failures.length === 0 ? (
					<Empty />
				) : (
					<ul className="space-y-1">
						{report.failures.map((row) => (
							<li key={row.cause} className="flex justify-between gap-2">
								<span>{t(`usage.dashboard.causes.${row.cause}`)}</span>
								<span className="text-muted-foreground">
									{t("usage.dashboard.failureCounts", { runs: row.runs, jobs: row.jobs })}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

export function PresenceSection({
	report,
	onOpen,
	onDeactivate,
}: {
	readonly report: UsagePresence;
	readonly onOpen: (personId: string) => void;
	readonly onDeactivate?: (personId: string) => void;
}) {
	const { t } = useTranslation("administration");
	const name = (person: { user_id: string | null; name: string | null }) =>
		person.user_id ? (
			<button
				type="button"
				className="text-primary hover:underline"
				onClick={() => onOpen(person.user_id as string)}
			>
				{person.name ?? person.user_id}
			</button>
		) : (
			<span className="text-muted-foreground">{t("usage.dashboard.nobody")}</span>
		);
	return (
		<div className="grid gap-4 lg:grid-cols-3">
			<div className="space-y-1 text-sm">
				<h4 className="text-xs font-semibold text-muted-foreground">
					{t("usage.dashboard.online", { count: report.online.length })}
				</h4>
				{report.online.length === 0 ? (
					<Empty />
				) : (
					<ul className="space-y-1">
						{report.online.map((person) => (
							<li key={person.user_id}>{name(person)}</li>
						))}
					</ul>
				)}
			</div>
			<div className="space-y-1 text-sm">
				<h4 className="text-xs font-semibold text-muted-foreground">
					{t("usage.dashboard.running", { count: report.running.length })}
				</h4>
				{report.running.length === 0 ? (
					<Empty />
				) : (
					<ul className="space-y-1">
						{report.running.map((row) => (
							<li key={`${row.kind}-${row.started_at}-${row.what}-${row.user_id}`}>
								{t("usage.dashboard.runningRow", {
									what: row.what,
									project: row.project ?? "–",
									since: formatAppDateTime(row.started_at),
								})}{" "}
								{name(row)}
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="space-y-1 text-sm">
				<h4 className="text-xs font-semibold text-muted-foreground">
					{t("usage.dashboard.dormant", { days: report.dormant_after_days })}
				</h4>
				{report.dormant.length === 0 ? (
					<Empty />
				) : (
					<ul className="space-y-1">
						{report.dormant.map((person) => (
							<li key={person.user_id} className="flex items-center justify-between gap-2">
								<span>
									{name(person)}{" "}
									<span className="text-xs text-muted-foreground">
										{person.last_seen_at
											? formatAppDateTime(person.last_seen_at)
											: t("usage.dashboard.neverSeen")}
									</span>
								</span>
								{onDeactivate && person.user_id && (
									<Button
										size="sm"
										variant="outline"
										onClick={() => onDeactivate(person.user_id as string)}
									>
										{t("usage.dashboard.deactivate")}
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
