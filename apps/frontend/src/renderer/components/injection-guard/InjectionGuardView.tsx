import { AlertTriangle, Play, RotateCcw, ShieldCheck, Square } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { useInjectionGuardStore } from "../../stores/injection-guard-store";
import type {
	InjectionScanResult,
	ScanFinding,
	ThreatLevel,
} from "../../../shared/types/injection-guard";
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

const THREAT_TONES: Record<ThreatLevel, Tone> = {
	safe: "green",
	suspect: "amber",
	blocked: "red",
};

const SEVERITY_TONES: Record<ScanFinding["severity"], Tone> = {
	critical: "red",
	high: "orange",
	medium: "amber",
	low: "blue",
};

interface InjectionGuardViewProps {
	readonly projectPath?: string;
}

/** Saved prompts checked for injection attempts, layer by layer. */
export function InjectionGuardView({
	projectPath,
}: InjectionGuardViewProps): React.ReactElement {
	const { t } = useTranslation(["injectionGuard", "navigation"]);

	const phase = useInjectionGuardStore((s) => s.phase);
	const status = useInjectionGuardStore((s) => s.status);
	const results = useInjectionGuardStore((s) => s.results);
	const error = useInjectionGuardStore((s) => s.error);
	const startScan = useInjectionGuardStore((s) => s.startScan);
	const cancelScan = useInjectionGuardStore((s) => s.cancelScan);
	const reset = useInjectionGuardStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const count = (level: ThreatLevel) => results.filter((r) => r.threatLevel === level).length;

	return (
		<ModuleStage scroll="page" data-testid="injection-guard-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("injectionGuard:title")}
				description={t("injectionGuard:description")}
				icon={ShieldCheck}
				tone="orange"
				actions={
					<>
						{phase === "complete" && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("injectionGuard:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => void cancelScan()}>
								{t("injectionGuard:actions.cancel")}
							</CharterButton>
						) : (
							<CharterButton
								variant="primary"
								icon={Play}
								onClick={() => projectPath && void startScan(projectPath)}
								disabled={!projectPath}
							>
								{t("injectionGuard:actions.runScan")}
							</CharterButton>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("injectionGuard:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("injectionGuard:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("injectionGuard:errors.failed", { error })}
					</Notice>
				)}
				{results.length > 0 ? (
					<>
						<Stats>
							<Stat label={t("injectionGuard:stats.blocked")} value={count("blocked")} tone="red" />
							<Stat label={t("injectionGuard:stats.suspect")} value={count("suspect")} tone="amber" />
							<Stat label={t("injectionGuard:stats.safe")} value={count("safe")} tone="green" />
						</Stats>
						<Section kicker={t("injectionGuard:kickers.prompts")} title={t("injectionGuard:promptsTitle")}>
							<div className="grid gap-2.5 lg:grid-cols-2">
								{results.map((result) => (
									<ResultPanel key={result.source} result={result} />
								))}
							</div>
						</Section>
					</>
				) : (
					!isScanning && (
						<EmptyStage
							icon={ShieldCheck}
							tone="orange"
							title={t(
								phase === "complete" ? "injectionGuard:emptyTitle" : "injectionGuard:idleTitle",
							)}
						>
							{t("injectionGuard:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function ResultPanel({ result }: { readonly result: InjectionScanResult }): React.ReactElement {
	const { t } = useTranslation("injectionGuard");
	const tone = THREAT_TONES[result.threatLevel];
	return (
		<Panel rail tone={tone}>
			<div className="flex items-start justify-between gap-2">
				<span className="wp-title truncate font-mono text-sm" title={result.source}>
					{result.source}
				</span>
				<Chip tone={tone}>{t(`threat.${result.threatLevel}`)}</Chip>
			</div>
			{result.findings.length > 0 ? (
				<ul className="mt-2 grid gap-1.5">
					{result.findings.map((f) => (
						<li key={`${f.layer}-${f.description}`} className="flex items-center gap-2 text-xs">
							<Chip tone={SEVERITY_TONES[f.severity]} dot={false}>
								{t(`severities.${f.severity}`, { defaultValue: f.severity })}
							</Chip>
							<span className="wp-meta shrink-0">{t(`layers.${f.layer}`, { defaultValue: f.layer })}</span>
							<span className="min-w-0 flex-1 truncate">{f.description}</span>
							<span className="wp-meta font-mono">{(f.confidence * 100).toFixed(0)}%</span>
						</li>
					))}
				</ul>
			) : (
				<p className="wp-muted mt-1.5 text-xs">{t("noFindings")}</p>
			)}
		</Panel>
	);
}
