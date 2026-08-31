/**
 * The control dashboard: what this tenant is doing right now, and how close to
 * its ceilings.
 *
 * Everything shown is aggregated server-side from data that already existed
 * (agent runs, specs, projects, memberships) — this view produces no new
 * telemetry, it answers the question an operator actually has.
 */
import { AlertTriangle, Activity, FolderGit2, Users } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";

function StatCard({
	icon: Icon,
	label,
	value,
	hint,
	tone = "default",
}: {
	readonly icon: React.ElementType;
	readonly label: string;
	readonly value: string | number;
	readonly hint?: string;
	readonly tone?: "default" | "warning";
}) {
	return (
		<Card>
			<CardContent className="p-5">
				<div className="flex items-center gap-2 mb-2">
					<Icon
						className={`h-4 w-4 ${
							tone === "warning" ? "text-destructive" : "text-muted-foreground"
						}`}
					/>
					<span className="text-xs uppercase tracking-wider text-muted-foreground">
						{label}
					</span>
				</div>
				<div
					className={`text-2xl font-bold ${
						tone === "warning" ? "text-destructive" : ""
					}`}
				>
					{value}
				</div>
				{hint ? (
					<div className="text-xs text-muted-foreground mt-1">{hint}</div>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * A bar chart drawn with plain divs.
 *
 * The repository ships no charting library and its existing charts are
 * hand-rolled SVG or stacked divs; adding recharts for eight bars would be a
 * dependency nobody asked for.
 */
function RunsByDay({
	data,
	label,
}: {
	readonly data: Array<{ date: string; count: number }>;
	readonly label: string;
}) {
	const max = Math.max(1, ...data.map((d) => d.count));
	return (
		<section className="border border-border rounded-md p-4">
			<h3 className="text-sm font-medium mb-4">{label}</h3>
			<div className="flex items-end gap-2 h-32" role="img" aria-label={label}>
				{data.map((point) => (
					<div key={point.date} className="flex-1 flex flex-col items-center gap-1">
						<div
							className="w-full bg-primary/70 rounded-t min-h-[2px]"
							style={{ height: `${(point.count / max) * 100}%` }}
							title={`${point.date}: ${point.count}`}
						/>
						<span className="text-[10px] text-muted-foreground">
							{point.date.slice(5)}
						</span>
					</div>
				))}
			</div>
		</section>
	);
}

function QuotaBar({
	label,
	used,
	limit,
}: {
	readonly label: string;
	readonly used: number;
	readonly limit: number | null;
}) {
	const { t } = useTranslation("administration");
	// No limit is the default: an organization with no quota row is unlimited,
	// and showing a full bar there would be a lie.
	const ratio = limit ? Math.min(1, used / limit) : 0;
	const nearing = limit !== null && ratio >= 0.9;
	return (
		<div className="space-y-1">
			<div className="flex justify-between text-xs">
				<span className="text-muted-foreground">{label}</span>
				<span className={nearing ? "text-destructive font-medium" : ""}>
					{limit === null
						? t("quotas.unlimitedUsage", { used })
						: `${used} / ${limit}`}
				</span>
			</div>
			<div className="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className={`h-full rounded-full ${
						nearing ? "bg-destructive" : "bg-primary"
					}`}
					style={{ width: `${ratio * 100}%` }}
				/>
			</div>
		</div>
	);
}

export function OverviewTab() {
	const { t } = useTranslation("administration");
	const overview = useAdminStore((s) => s.overview);
	const loading = useAdminStore((s) => s.loading.overview);
	const loadOverview = useAdminStore((s) => s.loadOverview);

	useEffect(() => {
		void loadOverview();
	}, [loadOverview]);

	if (!overview) {
		return (
			<p className="text-sm text-muted-foreground">
				{loading ? t("common.loading") : t("overview.empty")}
			</p>
		);
	}

	const successPercent = Math.round(overview.run_success_rate_7d * 100);

	return (
		<div className="space-y-6">
			<section className="grid grid-cols-2 md:grid-cols-4 gap-3">
				<StatCard
					icon={Activity}
					label={t("overview.activeRuns")}
					value={overview.runs_active}
					hint={t("overview.queued", { count: overview.runs_queued })}
				/>
				<StatCard
					icon={AlertTriangle}
					label={t("overview.failed24h")}
					value={overview.runs_failed_24h}
					hint={t("overview.of24h", { count: overview.runs_24h })}
					tone={overview.runs_failed_24h > 0 ? "warning" : "default"}
				/>
				<StatCard
					icon={Users}
					label={t("overview.members")}
					value={overview.users_active}
					hint={t("overview.ofTotal", { count: overview.users_total })}
				/>
				<StatCard
					icon={FolderGit2}
					label={t("overview.projects")}
					value={overview.projects_total}
					hint={t("overview.specs", { count: overview.specs_total })}
				/>
			</section>

			<section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<RunsByDay data={overview.runs_by_day} label={t("overview.runsByDay")} />

				<section className="border border-border rounded-md p-4 space-y-4">
					<h3 className="text-sm font-medium">{t("overview.capacity")}</h3>
					<QuotaBar
						label={t("quotas.maxUsers")}
						used={overview.quota.used_users}
						limit={overview.quota.max_users}
					/>
					<QuotaBar
						label={t("quotas.maxProjects")}
						used={overview.quota.used_projects}
						limit={overview.quota.max_projects}
					/>
					<QuotaBar
						label={t("quotas.maxConcurrentRuns")}
						used={overview.quota.used_concurrent_runs}
						limit={overview.quota.max_concurrent_runs}
					/>
					<div className="pt-2 border-t border-border">
						<div className="flex justify-between text-xs">
							<span className="text-muted-foreground">
								{t("overview.successRate")}
							</span>
							<span className="font-medium">{successPercent}%</span>
						</div>
					</div>
				</section>
			</section>

			{overview.top_users.length > 0 && (
				<section className="border border-border rounded-md p-4">
					<h3 className="text-sm font-medium mb-3">{t("overview.topUsers")}</h3>
					<ul className="divide-y divide-border">
						{overview.top_users.map((entry) => (
							<li
								key={entry.user_id}
								className="flex justify-between py-2 text-sm"
							>
								<span>{entry.display_name}</span>
								<span className="text-muted-foreground">
									{t("overview.runsCount", { count: entry.runs })}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{overview.recent_failures.length > 0 && (
				<section className="border border-border rounded-md p-4">
					<h3 className="text-sm font-medium mb-3">
						{t("overview.recentFailures")}
					</h3>
					<ul className="divide-y divide-border">
						{overview.recent_failures.map((failure) => (
							<li key={failure.run_id} className="py-2 text-sm">
								<div className="flex justify-between">
									<span className="font-medium">{failure.phase}</span>
									<span className="text-xs text-muted-foreground">
										{new Date(failure.finished_at).toLocaleString()}
									</span>
								</div>
								{failure.error ? (
									<p className="text-xs text-muted-foreground mt-1 break-words">
										{failure.error}
									</p>
								) : null}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
