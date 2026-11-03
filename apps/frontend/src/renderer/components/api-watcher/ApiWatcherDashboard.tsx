import type React from "react";
import { useTranslation } from "react-i18next";
import { useApiWatcherStore } from "../../stores/api-watcher-store";
import type {
	ContractChange,
	ContractDiff,
} from "../../../shared/types/api-watcher";

const CATEGORY_STYLES: Record<string, { color: string; icon: string }> = {
	breaking: { color: "text-destructive bg-destructive/10", icon: "🔴" },
	potentially_breaking: {
		color: "text-warning bg-warning/10",
		icon: "🟡",
	},
	non_breaking: { color: "text-success bg-success/10", icon: "🟢" },
};

interface ApiWatcherDashboardProps {
	readonly projectPath?: string;
}

export function ApiWatcherDashboard({
	projectPath,
}: ApiWatcherDashboardProps): React.ReactElement {
	const { t } = useTranslation("apiWatcher");

	const phase = useApiWatcherStore((s) => s.phase);
	const status = useApiWatcherStore((s) => s.status);
	const result = useApiWatcherStore((s) => s.result);
	const error = useApiWatcherStore((s) => s.error);
	const startScan = useApiWatcherStore((s) => s.startScan);
	const cancelScan = useApiWatcherStore((s) => s.cancelScan);
	const reset = useApiWatcherStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const canRun = !!projectPath && !isScanning;

	return (
		<div className="flex flex-col gap-4 p-6 bg-background text-foreground">
			<div className="flex items-center gap-3 flex-wrap">
				{isScanning ? (
					<button
						type="button"
						onClick={() => cancelScan()}
						className="px-3 py-1.5 rounded bg-destructive/10 text-destructive border border-destructive/20 text-sm hover:bg-destructive/20"
					>
						{t("actions.cancel")}
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={() => projectPath && startScan(projectPath, false)}
							disabled={!canRun}
							className="px-3 py-1.5 rounded bg-primary text-white text-sm disabled:opacity-50"
						>
							{t("actions.runScan")}
						</button>
						<button
							type="button"
							onClick={() => projectPath && startScan(projectPath, true)}
							disabled={!canRun}
							className="px-3 py-1.5 rounded bg-card border border-border text-sm disabled:opacity-50 hover:bg-muted"
						>
							{t("actions.saveBaseline")}
						</button>
					</>
				)}
				{result && !isScanning && (
					<button
						type="button"
						onClick={reset}
						className="px-3 py-1.5 rounded bg-card border border-border text-sm hover:bg-muted"
					>
						{t("actions.reset")}
					</button>
				)}
			</div>

			{!projectPath && (
				<div className="text-sm text-muted-foreground">
					{t("errors.noProject")}
				</div>
			)}

			{isScanning && (
				<div className="text-sm text-muted-foreground animate-pulse">
					{status || t("actions.scanning")}
				</div>
			)}

			{phase === "error" && error && (
				<div className="text-sm text-destructive">
					{t("errors.failed", { error })}
				</div>
			)}

			{result?.diff ? (
				<ReportBody
					diff={result.diff}
					migrationGuideMarkdown={result.migrationGuideMarkdown}
					summary={result.summary}
					t={t}
				/>
			) : (
				phase === "idle" && (
					<div className="flex items-center justify-center h-40 text-muted-foreground">
						<p>{t("noData")}</p>
					</div>
				)
			)}
		</div>
	);
}

function ReportBody({
	diff,
	migrationGuideMarkdown,
	summary,
	t,
}: {
	readonly diff: ContractDiff;
	readonly migrationGuideMarkdown: string;
	readonly summary: string;
	readonly t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
	const hasChanges = diff.changes.length > 0;
	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-semibold">{t("title")}</h2>
				<p className="text-sm text-muted-foreground">
					{summary ||
						(hasChanges
							? t("changesDetected", { count: diff.changes.length })
							: t("noChanges"))}
				</p>
			</div>

			<div className="grid grid-cols-3 gap-3">
				<div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
					<p className="text-xs text-destructive">{t("categories.breaking")}</p>
					<p className="text-2xl font-bold text-destructive">
						{diff.breakingCount}
					</p>
				</div>
				<div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
					<p className="text-xs text-warning">
						{t("categories.potentiallyBreaking")}
					</p>
					<p className="text-2xl font-bold text-warning">
						{diff.potentiallyBreakingCount}
					</p>
				</div>
				<div className="p-3 rounded-lg bg-success/10 border border-success/20">
					<p className="text-xs text-success">
						{t("categories.nonBreaking")}
					</p>
					<p className="text-2xl font-bold text-success">
						{diff.nonBreakingCount}
					</p>
				</div>
			</div>

			<div className="space-y-2">
				{diff.changes.map((change) => (
					<ChangeRow key={change.path} change={change} />
				))}
			</div>

			{migrationGuideMarkdown && (
				<div className="mt-4 p-4 rounded-lg bg-card border border-border">
					<h3 className="text-sm font-medium mb-2">{t("migrationGuide")}</h3>
					<pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">
						{migrationGuideMarkdown}
					</pre>
				</div>
			)}
		</div>
	);
}

function ChangeRow({
	change,
}: {
	readonly change: ContractChange;
}): React.ReactElement {
	const style =
		CATEGORY_STYLES[change.category] ?? CATEGORY_STYLES.non_breaking;
	return (
		<div
			className={`flex items-center gap-3 px-3 py-2 rounded-lg ${style.color}`}
		>
			<span>{style.icon}</span>
			<div className="flex-1 min-w-0">
				<p className="text-sm">{change.description}</p>
				<p className="text-xs opacity-70 font-mono">{change.path}</p>
			</div>
			<span className="text-xs opacity-70">
				{change.changeType.replaceAll("_", " ")}
			</span>
		</div>
	);
}
