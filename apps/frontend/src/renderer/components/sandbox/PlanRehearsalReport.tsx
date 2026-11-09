import { AlertTriangle, CheckCircle2, Info, OctagonX } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type {
	FindingLevel,
	MockResponse,
	SimulationFinding,
	SimulationResult,
	SimulationStep,
	StepStatus,
} from "../../../shared/types/sandbox";
import { Chip, Chips, Column, Columns, Notice, Panel, Stat, Stats, type Tone } from "../charter";

const STEP_TONES: Record<StepStatus, Tone> = {
	success: "green",
	warning: "amber",
	error: "red",
	skipped: "muted",
};

const LEVEL_TONES: Record<FindingLevel, Tone> = { error: "red", warning: "amber", info: "blue" };

const VERDICT = {
	ready: { tone: "green", icon: CheckCircle2 },
	review: { tone: "amber", icon: AlertTriangle },
	blocked: { tone: "red", icon: OctagonX },
} as const;

/** One finding in the user's language, the backend's English text as a fallback. */
function FindingLine({ finding }: { readonly finding: SimulationFinding }): React.ReactElement {
	const { t } = useTranslation("sandbox");
	return (
		<li className="flex items-start gap-2 text-sm">
			<Chip tone={LEVEL_TONES[finding.level]}>{t(`levels.${finding.level}`)}</Chip>
			<span className="break-words">
				{t(`findings.${finding.code}`, { ...finding.params, defaultValue: finding.message })}
			</span>
		</li>
	);
}

function MockLine({ mock }: { readonly mock: MockResponse }): React.ReactElement {
	const { t } = useTranslation("sandbox");
	return (
		<Panel padded={false} className="overflow-hidden">
			<div className="wp-meta flex flex-wrap items-center gap-2 border-b border-[var(--wp-border)] px-3 py-1 font-mono">
				<span>
					{mock.method} {mock.url} → {mock.statusCode}
				</span>
				<Chip tone={mock.strategy === "schema_based" ? "green" : "muted"} dot={false}>
					{t(`strategies.${mock.strategy}`)}
				</Chip>
			</div>
			{mock.body && (
				<pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-xs leading-5">{mock.body}</pre>
			)}
		</Panel>
	);
}

function StepPanel({ step }: { readonly step: SimulationStep }): React.ReactElement {
	const { t } = useTranslation("sandbox");
	const findings = step.findings ?? [];
	return (
		<Panel rail tone={STEP_TONES[step.status]} data-testid="rehearsal-step">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p className="text-sm">
					<span className="font-mono">{step.subtaskId}</span> · {step.description}
				</p>
				<Chip tone={STEP_TONES[step.status]}>{t(`stepStatus.${step.status}`)}</Chip>
			</div>
			{step.phase && <p className="wp-meta mt-1">{step.phase}</p>}
			{findings.length > 0 && <ul className="mt-2 grid gap-1.5">{findings.map((f) => <FindingLine key={`${f.code}:${JSON.stringify(f.params)}`} finding={f} />)}</ul>}
			{step.mockApiCalls.length > 0 && (
				<div className="mt-2 grid gap-1.5">
					{step.mockApiCalls.map((mock) => (
						<MockLine key={`${mock.method} ${mock.url}`} mock={mock} />
					))}
				</div>
			)}
		</Panel>
	);
}

/** The rehearsal of a plan: verdict, subtasks with their findings, predicted files. */
export function PlanRehearsalReport({ result }: { readonly result: SimulationResult }): React.ReactElement {
	const { t } = useTranslation("sandbox");
	const verdict = VERDICT[result.verdict ?? "review"];
	const VerdictIcon = verdict.icon;
	const planFindings = result.planFindings ?? [];
	const estimate = result.costEstimate;
	const added = result.diffs.filter((d) => d.changeType === "added");
	const modified = result.diffs.filter((d) => d.changeType !== "added");

	return (
		<div className="relative z-[1] flex flex-1 flex-col gap-3 overflow-auto p-6" data-testid="plan-rehearsal-report">
			<Notice tone={verdict.tone} icon={VerdictIcon} role="status">
				{t(`verdict.${result.verdict ?? "review"}`, { ref: result.baseRef ?? "HEAD" })}
			</Notice>
			<Stats>
				<Stat label={t("plan.subtasksOk")} value={`${result.successCount}/${result.steps.length}`} tone="green" />
				<Stat label={t("warnings")} value={result.warningCount} tone={result.warningCount ? "amber" : "muted"} />
				<Stat label={t("plan.errors")} value={result.errorCount} tone={result.errorCount ? "red" : "muted"} />
				<Stat label={t("plan.rehearsalCost")} value={t("plan.free")} tone="green" />
				<Stat
					label={t("plan.buildEstimate")}
					value={estimate ? `$${estimate.total_cost_usd.toFixed(2)}` : t("plan.unknown")}
					tone="blue"
				/>
			</Stats>
			{estimate && (
				<p className="wp-meta">
					{t("plan.estimateDetail", {
						confidence: t(`plan.confidence.${estimate.confidence}`),
						models: estimate.phases.map((p) => `${p.phase}: ${p.model}`).join(" · "),
					})}
				</p>
			)}
			{result.partial && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("plan.partial")}
				</Notice>
			)}
			{planFindings.length > 0 && (
				<Panel tone="red" rail>
					<p className="wp-kicker mb-1.5">{t("plan.structure")}</p>
					<ul className="grid gap-1.5">
						{planFindings.map((f) => (
							<FindingLine key={`${f.code}:${JSON.stringify(f.params)}`} finding={f} />
						))}
					</ul>
				</Panel>
			)}
			<Columns template="minmax(0, 2fr) minmax(0, 1fr)">
				<Column
					kicker={t("plan.kickers.walk")}
					title={t("plan.subtasks", { count: result.steps.length })}
					tone="violet"
				>
					<div className="grid gap-2">
						{result.steps.map((step) => (
							<StepPanel key={step.index} step={step} />
						))}
					</div>
				</Column>
				<Column
					kicker={t("plan.kickers.footprint")}
					title={t("diffPreview.filesChanged", { count: result.diffs.length })}
					meta={t("plan.footprintMeta", { added: added.length, modified: modified.length })}
					tone="blue"
				>
					<div className="grid gap-1.5">
						{result.diffs.map((diff) => (
							<div key={diff.filePath} className="flex items-baseline justify-between gap-2">
								<span className="break-all font-mono text-xs">{diff.filePath}</span>
								<Chip tone={diff.changeType === "added" ? "green" : "blue"} dot={false}>
									{t(`changeTypes.${diff.changeType}`)}
								</Chip>
							</div>
						))}
					</div>
					<p className="wp-kicker mt-4 mb-1.5">{t("plan.contracts")}</p>
					{result.contracts && result.contracts.length > 0 ? (
						<Chips>
							{result.contracts.map((c) => (
								<Chip key={c} tone="muted" dot={false}>
									<span className="font-mono">{c}</span>
								</Chip>
							))}
						</Chips>
					) : (
						<p className="wp-muted flex items-center gap-1.5 text-sm">
							<Info className="h-3.5 w-3.5" aria-hidden="true" />
							{t("plan.noContracts")}
						</p>
					)}
				</Column>
			</Columns>
		</div>
	);
}
