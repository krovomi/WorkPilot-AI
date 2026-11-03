import type React from "react";
import { useTranslation } from "react-i18next";
import { useConsensusArbiterStore } from "../../stores/consensus-arbiter-store";
import type {
	ConflictSeverity,
	ConsensusResult,
} from "../../../shared/types/consensus-arbiter";

const SEVERITY_STYLES: Record<ConflictSeverity, string> = {
	critical: "text-destructive bg-destructive/10 border-destructive/20",
	high: "text-orange-400 bg-orange-500/10 border-orange-500/20",
	medium: "text-warning bg-warning/10 border-warning/20",
	low: "text-blue-400 bg-blue-500/10 border-blue-500/20",
};

interface ConsensusViewProps {
	readonly projectPath?: string;
}

function ResultBody({
	result,
	t,
}: {
	readonly result: ConsensusResult;
	readonly t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactElement {
	return (
		<>
			<p className="text-sm text-muted-foreground">
				{result.conflicts.length} {t("disagreements")} ·{" "}
				{result.resolvedCount} {t("agreements")} · {result.escalatedCount}{" "}
				{t("escalated")}
			</p>

			{result.allResolved ? (
				<div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm">
					✅ {t("allConflictsResolved")}
				</div>
			) : (
				<div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-sm">
					⚠️ {result.escalatedCount} {t("conflictsRequireHumanDecision")}
				</div>
			)}

			<div className="space-y-3">
				{result.conflicts.map((conflict) => (
					<div
						key={`${conflict.topic}-${conflict.severity}`}
						className={`px-4 py-3 rounded-lg border ${SEVERITY_STYLES[conflict.severity]}`}
					>
						<div className="flex items-center justify-between mb-2">
							<p className="text-sm font-medium">{conflict.topic}</p>
							<div className="flex items-center gap-2">
								{conflict.strategyUsed && (
									<span className="text-xs opacity-70">
										{conflict.strategyUsed.replaceAll("_", " ")}
									</span>
								)}
								<span
									className={`px-2 py-0.5 rounded text-xs font-medium ${
										conflict.resolved
											? "bg-success/20 text-success"
											: "bg-warning/20 text-warning"
									}`}
								>
									{conflict.resolved ? t("resolved") : t("pending")}
								</span>
							</div>
						</div>

						<div className="space-y-1 mb-2">
							{conflict.opinions.map((op) => (
								<div
									key={op.agentName}
									className="flex items-center gap-2 text-xs"
								>
									<span className="font-medium w-24 shrink-0">
										{op.agentName}
									</span>
									<span className="opacity-70 w-16 shrink-0">{op.domain}</span>
									<span className="flex-1 truncate">{op.recommendation}</span>
									<span className="opacity-70">
										{(op.confidence * 100).toFixed(0)}%
									</span>
								</div>
							))}
						</div>

						{conflict.resolution && (
							<p className="text-xs mt-1 text-success">
								→ {conflict.resolution}
							</p>
						)}
					</div>
				))}
			</div>

			{result.consensusSummary && (
				<p className="text-sm text-muted-foreground italic mt-2">
					{result.consensusSummary}
				</p>
			)}
		</>
	);
}

export function ConsensusView({
	projectPath,
}: ConsensusViewProps): React.ReactElement {
	const { t } = useTranslation("consensusArbiter");

	const phase = useConsensusArbiterStore((s) => s.phase);
	const status = useConsensusArbiterStore((s) => s.status);
	const result = useConsensusArbiterStore((s) => s.result);
	const error = useConsensusArbiterStore((s) => s.error);
	const startScan = useConsensusArbiterStore((s) => s.startScan);
	const cancelScan = useConsensusArbiterStore((s) => s.cancelScan);
	const reset = useConsensusArbiterStore((s) => s.reset);

	const handleRun = (): void => {
		if (!projectPath) return;
		void startScan(projectPath);
	};

	const isScanning = phase === "scanning";

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

			{phase === "complete" && result?.conflicts.length === 0 && (
				<p className="text-sm text-muted-foreground">{t("noData")}</p>
			)}

			{phase === "complete" && result && result.conflicts.length > 0 && (
				<ResultBody result={result} t={t} />
			)}
		</div>
	);
}
