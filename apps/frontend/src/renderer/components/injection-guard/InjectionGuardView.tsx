import type React from "react";
import { useTranslation } from "react-i18next";
import { useInjectionGuardStore } from "../../stores/injection-guard-store";
import type {
	InjectionScanResult,
	ScanFinding,
	ThreatLevel,
} from "../../../shared/types/injection-guard";

const THREAT_STYLES: Record<ThreatLevel, string> = {
	safe: "text-success bg-success/10 border-success/20",
	suspect: "text-warning bg-warning/10 border-warning/20",
	blocked: "text-destructive bg-destructive/10 border-destructive/20",
};

const SEVERITY_COLORS: Record<string, string> = {
	critical: "text-destructive",
	high: "text-orange-400",
	medium: "text-warning",
	low: "text-blue-400",
};

interface InjectionGuardViewProps {
	readonly projectPath?: string;
}

function FindingRow({
	finding,
}: {
	readonly finding: ScanFinding;
}): React.ReactElement {
	return (
		<div className="flex items-center gap-2 text-xs">
			<span className="opacity-70 w-20 shrink-0">{finding.layer}</span>
			<span
				className={`font-medium w-20 shrink-0 ${SEVERITY_COLORS[finding.severity] ?? ""}`}
			>
				{finding.severity}
			</span>
			<span className="flex-1 truncate">{finding.description}</span>
			<span className="opacity-70">
				{(finding.confidence * 100).toFixed(0)}%
			</span>
		</div>
	);
}

function ResultCard({
	result,
	t,
}: {
	readonly result: InjectionScanResult;
	readonly t: (key: string) => string;
}): React.ReactElement {
	return (
		<div
			className={`px-4 py-3 rounded-lg border ${THREAT_STYLES[result.threatLevel]}`}
		>
			<div className="flex items-center justify-between mb-2">
				<p className="text-sm font-medium truncate">{result.source}</p>
				<span className="text-xs font-medium uppercase">
					{t(`threat.${result.threatLevel}`)}
				</span>
			</div>
			{result.findings.length > 0 ? (
				<div className="space-y-1">
					{result.findings.map((f) => (
						<FindingRow key={`${f.layer}-${f.description}`} finding={f} />
					))}
				</div>
			) : (
				<p className="text-xs opacity-70">{t("noFindings")}</p>
			)}
		</div>
	);
}

export function InjectionGuardView({
	projectPath,
}: InjectionGuardViewProps): React.ReactElement {
	const { t } = useTranslation("injectionGuard");

	const phase = useInjectionGuardStore((s) => s.phase);
	const status = useInjectionGuardStore((s) => s.status);
	const results = useInjectionGuardStore((s) => s.results);
	const error = useInjectionGuardStore((s) => s.error);
	const startScan = useInjectionGuardStore((s) => s.startScan);
	const cancelScan = useInjectionGuardStore((s) => s.cancelScan);
	const reset = useInjectionGuardStore((s) => s.reset);

	const handleRun = (): void => {
		if (!projectPath) return;
		void startScan(projectPath);
	};

	const isScanning = phase === "scanning";

	const blocked = results.filter((r) => r.threatLevel === "blocked").length;
	const suspect = results.filter((r) => r.threatLevel === "suspect").length;
	const safe = results.filter((r) => r.threatLevel === "safe").length;

	return (
		<div className="flex flex-col gap-4 p-6 bg-background text-foreground">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold">{t("title")}</h2>
				<div className="flex gap-2">
					{!isScanning && (
						<button
							type="button"
							onClick={handleRun}
							disabled={!projectPath}
							className="px-3 py-1.5 rounded-md bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
						>
							{t("actions.runScan")}
						</button>
					)}
					{isScanning && (
						<button
							type="button"
							onClick={() => void cancelScan()}
							className="px-3 py-1.5 rounded-md bg-destructive hover:bg-destructive/90 text-destructive-foreground text-sm font-medium transition-colors"
						>
							{t("actions.cancel")}
						</button>
					)}
					{phase === "complete" && (
						<button
							type="button"
							onClick={reset}
							className="px-3 py-1.5 rounded-md border border-border hover:bg-card text-sm font-medium transition-colors"
						>
							{t("actions.reset")}
						</button>
					)}
				</div>
			</div>

			{!projectPath && (
				<p className="text-sm text-muted-foreground">
					{t("errors.noProject")}
				</p>
			)}

			{isScanning && (
				<p className="text-sm text-muted-foreground">
					{status || t("actions.scanning")}
				</p>
			)}

			{phase === "error" && error && (
				<p className="text-sm text-destructive">{error}</p>
			)}

			{phase === "complete" && results.length === 0 && (
				<p className="text-sm text-muted-foreground">{t("noData")}</p>
			)}

			{results.length > 0 && (
				<>
					<div className="grid grid-cols-3 gap-3">
						<div className="p-3 rounded-lg bg-card border border-border">
							<p className="text-xs text-muted-foreground">
								{t("stats.blocked")}
							</p>
							<p className="text-2xl font-bold text-destructive">{blocked}</p>
						</div>
						<div className="p-3 rounded-lg bg-card border border-border">
							<p className="text-xs text-muted-foreground">
								{t("stats.suspect")}
							</p>
							<p className="text-2xl font-bold text-warning">{suspect}</p>
						</div>
						<div className="p-3 rounded-lg bg-card border border-border">
							<p className="text-xs text-muted-foreground">
								{t("stats.safe")}
							</p>
							<p className="text-2xl font-bold text-success">{safe}</p>
						</div>
					</div>

					<div className="space-y-2">
						{results.map((result) => (
							<ResultCard
								key={result.source}
								result={result}
								t={t}
							/>
						))}
					</div>
				</>
			)}
		</div>
	);
}
