import { AlertTriangle, Box, Eye, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useSandboxStore } from "../../stores/sandbox-store";
import type { SimulationResult, StepStatus } from "../../../shared/types/sandbox";
import {
	CharterButton,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Stat,
	Stats,
	type Tone,
} from "../charter";
import { DiffPreview } from "./DiffPreview";

const STEP_TONES: Record<StepStatus, Tone> = {
	success: "green",
	warning: "amber",
	error: "red",
	skipped: "muted",
};

interface SimulationReportProps {
	readonly projectPath?: string;
}

/** The uncommitted changes of the project, file by file, before they are committed. */
export function SimulationReport({ projectPath }: SimulationReportProps): React.ReactElement {
	const { t } = useTranslation(["sandbox", "navigation"]);

	const phase = useSandboxStore((s) => s.phase);
	const status = useSandboxStore((s) => s.status);
	const result = useSandboxStore((s) => s.result);
	const error = useSandboxStore((s) => s.error);
	const startScan = useSandboxStore((s) => s.startScan);
	const cancelScan = useSandboxStore((s) => s.cancelScan);
	const reset = useSandboxStore((s) => s.reset);

	const isScanning = phase === "scanning";

	return (
		<ModuleStage data-testid="sandbox-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("sandbox:title")}
				description={t("sandbox:description")}
				icon={Box}
				tone="violet"
				actions={
					<>
						{phase === "complete" && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("sandbox:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => void cancelScan()}>
								{t("sandbox:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Eye}
								onClick={() => projectPath && void startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("sandbox:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>

			{phase === "complete" && result && result.diffs.length > 0 ? (
				<DiffPreview key={result.id} diffs={result.diffs} aside={<RunSummary result={result} />} />
			) : (
				<div className="relative z-[1] flex flex-1 flex-col items-center justify-center gap-3 p-8">
					{!projectPath && (
						<Notice tone="amber" icon={AlertTriangle}>
							{t("sandbox:errors.noProject")}
						</Notice>
					)}
					{isScanning && <ScanLine label={status || t("sandbox:actions.scanning")} />}
					{phase === "error" && error && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{t("sandbox:errors.failed", { error })}
						</Notice>
					)}
					{!isScanning && (
						<EmptyStage
							icon={Box}
							tone="violet"
							title={t(phase === "complete" ? "sandbox:noChanges" : "sandbox:noData")}
						>
							{t("sandbox:emptyBody")}
						</EmptyStage>
					)}
				</div>
			)}
		</ModuleStage>
	);
}

/** Steps, warnings and cost only exist when a run produced the changes. */
function RunSummary({ result }: { readonly result: SimulationResult }): React.ReactElement | null {
	const { t } = useTranslation("sandbox");
	if (result.steps.length === 0) return null;
	return (
		<div className="mb-3 space-y-2.5">
			<Stats>
				<Stat label={t("steps")} value={`${result.successCount}/${result.steps.length}`} tone="green" />
				<Stat label={t("warnings")} value={result.warningCount} tone={result.warningCount ? "amber" : "muted"} />
				<Stat label={t("cost")} value={`$${result.estimatedCostUsd.toFixed(4)}`} tone="blue" />
			</Stats>
			{result.steps.map((step) => (
				<Panel key={step.index} rail tone={STEP_TONES[step.status]}>
					<p className="text-sm">{step.description}</p>
					<p className="wp-meta mt-1">
						{t("durationAndTokens", { duration: step.durationMs, tokens: step.tokensUsed })}
					</p>
				</Panel>
			))}
		</div>
	);
}
