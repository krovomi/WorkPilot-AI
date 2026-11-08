import { AlertTriangle, Play, RotateCcw, ShieldAlert, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useRegressionGuardianStore } from "../../stores/regression-guardian-store";
import type {
	IncidentSeverity,
	RegressionGuardianResult,
} from "../../../shared/types/regression-guardian";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	type Tone,
} from "../charter";

const SEVERITY_TONES: Record<IncidentSeverity, Tone> = {
	critical: "red",
	error: "orange",
	warning: "amber",
	info: "blue",
};

interface RegressionGuardianDashboardProps {
	readonly projectPath?: string;
}

/** Production incidents turned into skeleton regression tests, per stack. */
export function RegressionGuardianDashboard({
	projectPath,
}: RegressionGuardianDashboardProps): React.ReactElement {
	const { t } = useTranslation(["regressionGuardian", "navigation"]);

	const phase = useRegressionGuardianStore((s) => s.phase);
	const status = useRegressionGuardianStore((s) => s.status);
	const results = useRegressionGuardianStore((s) => s.results);
	const error = useRegressionGuardianStore((s) => s.error);
	const startScan = useRegressionGuardianStore((s) => s.startScan);
	const cancelScan = useRegressionGuardianStore((s) => s.cancelScan);
	const reset = useRegressionGuardianStore((s) => s.reset);

	const isScanning = phase === "scanning";

	return (
		<ModuleStage scroll="page" data-testid="regression-guardian-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("regressionGuardian:title")}
				description={t("regressionGuardian:description")}
				icon={ShieldAlert}
				tone="red"
				actions={
					<>
						{phase === "complete" && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("regressionGuardian:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => void cancelScan()}>
								{t("regressionGuardian:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && void startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("regressionGuardian:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("regressionGuardian:errors.noProject")}
					</Notice>
				)}
				{isScanning && (
					<ScanLine label={status || t("regressionGuardian:actions.scanning")} />
				)}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("regressionGuardian:errors.failed", { error })}
					</Notice>
				)}
				{results.length > 0 ? (
					<ResultsBody results={results} />
				) : (
					!isScanning && (
						<EmptyStage
							icon={ShieldAlert}
							tone="red"
							title={t(
								phase === "complete"
									? "regressionGuardian:emptyTitle"
									: "regressionGuardian:idleTitle",
							)}
						>
							{t("regressionGuardian:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function ResultsBody({
	results,
}: {
	readonly results: readonly RegressionGuardianResult[];
}): React.ReactElement {
	const { t } = useTranslation("regressionGuardian");
	const generated = results.filter((r) => r.generatedTest && !r.isDuplicate).length;
	const duplicates = results.filter((r) => r.isDuplicate).length;

	return (
		<>
			<Stats>
				<Stat label={t("stats.incidents")} value={results.length} tone="blue" />
				<Stat label={t("stats.testsGenerated")} value={generated} tone="green" />
				<Stat
					label={t("stats.duplicatesSkipped")}
					value={duplicates}
					tone={duplicates ? "amber" : "muted"}
				/>
			</Stats>
			<Section
				kicker={t("kickers.incidents")}
				title={t("incidentsDetected", { count: results.length })}
			>
				<div className="grid gap-2.5">
					{results.map((result) => (
						<IncidentPanel key={result.incident.id} result={result} />
					))}
				</div>
			</Section>
		</>
	);
}

function IncidentPanel({
	result,
}: {
	readonly result: RegressionGuardianResult;
}): React.ReactElement {
	const { t } = useTranslation("regressionGuardian");
	const { incident, generatedTest: test } = result;
	const tone = SEVERITY_TONES[incident.severity] ?? "muted";

	return (
		<Panel rail tone={tone}>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<p className="wp-title truncate text-sm">{incident.title}</p>
					<p className="wp-meta">
						{incident.source} · {incident.exceptionType || t("unknownException")}
						{incident.faultingFile ? ` · ${incident.faultingFile}` : ""}
					</p>
				</div>
				<div className="wp-chips">
					<Chip tone={tone}>{t(`severities.${incident.severity}`, { defaultValue: incident.severity })}</Chip>
					{result.isDuplicate ? (
						<Chip tone="amber" title={result.duplicatePath || undefined}>
							{t("duplicate")}
						</Chip>
					) : test ? (
						<Chip tone="green" dot={false}>
							{t(`frameworks.${test.framework}`, { defaultValue: test.framework })}
						</Chip>
					) : (
						<Chip tone="muted">{t("noTest")}</Chip>
					)}
				</div>
			</div>
			{incident.exceptionMessage && (
				<p className="wp-muted mt-1.5 text-xs">{incident.exceptionMessage}</p>
			)}
			{test && !result.isDuplicate && (
				<details className="mt-2">
					<summary className="wp-meta cursor-pointer">
						{t("viewTest")} · <span className="font-mono">{test.filePath}</span>
					</summary>
					<pre className="wp-code mt-2 max-h-80 overflow-auto text-xs">{test.code}</pre>
				</details>
			)}
		</Panel>
	);
}
