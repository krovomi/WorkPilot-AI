import { AlertTriangle, Info, RotateCcw, Target } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	EstimationCalibration,
	SmartEstimationResult,
} from "../../../shared/types/smart-estimation";
import { persistUpdateTask } from "../../stores/task-store";
import { CharterButton, Notice } from "../charter";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { formatMetric, percent } from "./calibration-format";
import { CALIBRATION_METRICS, taskEstimateFrom } from "./task-estimate";

type Action =
	| { kind: "idle" }
	| { kind: "confirmReset" }
	| { kind: "busy" }
	| { kind: "saved"; score: number }
	| { kind: "reset" }
	| { kind: "error"; message: string };

interface Props {
	readonly result: SmartEstimationResult;
	readonly projectId: string | null;
	readonly sourceTaskId: string | null;
}

/**
 * The repository's calibration of an estimate (issue #367): the range of each
 * metric and its confidence, the breakdown by dimension, the red flags, how
 * each provider compares, the quality of past estimates, and the two actions
 * a person takes on it — their own score ("Adjust estimate") and a reset.
 * Renders nothing for a result that carries no calibration.
 */
export function EstimationCalibrationPanel({ result, projectId, sourceTaskId }: Props) {
	const { t, i18n } = useTranslation(["smartEstimation"]);
	const [score, setScore] = useState(String(result.complexity_score));
	const [action, setAction] = useState<Action>({ kind: "idle" });
	const calibration = result.calibration;
	if (!calibration) return null;

	const language = i18n.language;
	const metricLabel = (metric: string) => t(`smartEstimation:calibration.metrics.${metric}`);
	const parsed = Number(score);
	const validScore = Number.isInteger(parsed) && parsed >= 1 && parsed <= 13;
	const busy = action.kind === "busy";

	const fail = (err: unknown) =>
		setAction({ kind: "error", message: err instanceof Error ? err.message : String(err) });

	const adjust = async () => {
		setAction({ kind: "busy" });
		try {
			await window.electronAPI.adjustSmartEstimate({
				projectId: projectId as string,
				category: calibration.category,
				baseScore: calibration.complexity.base,
				adjustedScore: parsed,
			});
			if (sourceTaskId) {
				await persistUpdateTask(sourceTaskId, {
					metadata: {
						smartEstimate: {
							...taskEstimateFrom(result),
							complexityScore: parsed,
							adjustedScore: parsed,
						},
					},
				});
			}
			setAction({ kind: "saved", score: parsed });
		} catch (err) {
			fail(err);
		}
	};

	const reset = async () => {
		setAction({ kind: "busy" });
		try {
			await window.electronAPI.resetEstimationCalibration(projectId as string);
			setAction({ kind: "reset" });
		} catch (err) {
			fail(err);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-lg">
					<Target className="h-5 w-5" />
					{t("smartEstimation:calibration.title")}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<StatusNotice calibration={calibration} t={t} />

				<ul className="space-y-2" aria-label={t("smartEstimation:calibration.rangesLabel")}>
					{CALIBRATION_METRICS.map((metric) => {
						const row = calibration.metrics[metric];
						if (row.value === null) return null;
						return (
							<li key={metric} className="flex flex-wrap items-center gap-2 text-sm">
								<span className="font-medium">{metricLabel(metric)}</span>
								<span>{formatMetric(metric, row.value, language)}</span>
								{row.low !== null && row.high !== null && (
									<span className="text-muted-foreground">
										{t("smartEstimation:calibration.range", {
											low: formatMetric(metric, row.low, language),
											high: formatMetric(metric, row.high, language),
											percent: percent(row.confidence as number),
										})}
									</span>
								)}
								<Badge variant="outline" className="text-xs">
									{t(`smartEstimation:calibration.scope.${row.scope}`)}
								</Badge>
							</li>
						)
					})}
				</ul>

				{calibration.red_flags.length > 0 && (
					<ul className="space-y-1">
						{calibration.red_flags.map((flag) => (
							<li key={flag.metric}>
								<Notice tone="orange" icon={AlertTriangle}>
									{t(
										flag.factor >= 1
											? "smartEstimation:calibration.redFlagOver"
											: "smartEstimation:calibration.redFlagUnder",
										{
											metric: metricLabel(flag.metric),
											factor: flag.factor.toFixed(2),
											scope: t(`smartEstimation:calibration.scope.${flag.scope}`),
										},
									)}
								</Notice>
							</li>
						))}
					</ul>
				)}

				{result.dimensions && (
					<div className="space-y-2">
						<Label>{t("smartEstimation:calibration.dimensionsTitle")}</Label>
						<ul className="space-y-1">
							{result.dimensions.map((dimension) => (
								<li key={dimension.key} className="flex flex-wrap items-center gap-2 text-sm">
									<span>{t(`smartEstimation:calibration.dimensions.${dimension.key}`)}</span>
									<Badge variant="outline" className="text-xs">
										{t(`smartEstimation:calibration.levels.${dimension.level}`)}
									</Badge>
									{dimension.uncertain && (
										<Badge variant="secondary" className="text-xs">
											{t("smartEstimation:calibration.uncertain")}
										</Badge>
									)}
									{dimension.signals.map((signal) => (
										<code key={signal} className="text-xs text-muted-foreground">
											{signal}
										</code>
									))}
								</li>
							))}
						</ul>
					</div>
				)}

				{calibration.providers.length > 0 && (
					<div className="space-y-1">
						<Label>{t("smartEstimation:calibration.providersTitle")}</Label>
						<ul className="space-y-1 text-sm">
							{calibration.providers.map((row) => (
								<li key={row.provider}>
									{t("smartEstimation:calibration.provider", {
										provider: row.provider,
										samples: row.samples,
										cost: row.cost_ratio === null ? "—" : row.cost_ratio.toFixed(2),
										tokens: row.tokens_ratio === null ? "—" : row.tokens_ratio.toFixed(2),
									})}
								</li>
							))}
						</ul>
					</div>
				)}

				<QualityLines calibration={calibration} t={t} metricLabel={metricLabel} />

				<div className="flex flex-wrap items-end gap-2">
					<div className="space-y-1">
						<Label htmlFor="estimation-adjust">
							{t("smartEstimation:calibration.adjustLabel")}
						</Label>
						<Input
							id="estimation-adjust"
							type="number"
							min={1}
							max={13}
							step={1}
							value={score}
							onChange={(e) => setScore(e.target.value)}
							className="w-24"
						/>
					</div>
					<CharterButton
						variant="primary"
						onClick={() => void adjust()}
						disabled={!projectId || !validScore || busy}
					>
						{t("smartEstimation:calibration.adjust")}
					</CharterButton>
					{action.kind === "confirmReset" ? (
						<>
							<CharterButton icon={RotateCcw} onClick={() => void reset()}>
								{t("smartEstimation:calibration.confirmReset")}
							</CharterButton>
							<CharterButton onClick={() => setAction({ kind: "idle" })}>
								{t("smartEstimation:calibration.cancel")}
							</CharterButton>
						</>
					) : (
						<CharterButton
							icon={RotateCcw}
							onClick={() => setAction({ kind: "confirmReset" })}
							disabled={!projectId || busy}
						>
							{t("smartEstimation:calibration.reset")}
						</CharterButton>
					)}
				</div>

				{action.kind === "saved" && (
					<Notice tone="green" role="status">
						{t("smartEstimation:calibration.saved", { score: action.score })}
					</Notice>
				)}
				{action.kind === "reset" && (
					<Notice tone="green" role="status">
						{t("smartEstimation:calibration.resetDone")}
					</Notice>
				)}
				{action.kind === "error" && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{action.message}
					</Notice>
				)}
			</CardContent>
		</Card>
	);
}

type T = (key: string, options?: Record<string, unknown>) => string;

function StatusNotice({ calibration, t }: { readonly calibration: EstimationCalibration; readonly t: T }) {
	const category = t(`smartEstimation:calibration.categories.${calibration.category}`);
	if (calibration.status === "insufficient_history") {
		return (
			<Notice tone="amber" icon={Info}>
				{t("smartEstimation:calibration.insufficient", {
					samples: calibration.samples,
					min: calibration.min_samples,
					category,
				})}
			</Notice>
		);
	}
	return (
		<Notice tone="blue" icon={Info}>
			{t("smartEstimation:calibration.calibrated", {
				samples: calibration.samples,
				category,
			})}
		</Notice>
	);
}

function QualityLines({
	calibration,
	t,
	metricLabel,
}: {
	readonly calibration: EstimationCalibration;
	readonly t: T;
	readonly metricLabel: (metric: string) => string;
}) {
	const { mape, acceptance_rate, mean_interval_width } = calibration.quality;
	const errors = CALIBRATION_METRICS.flatMap((metric) => {
		const value = mape[metric];
		return value === null ? [] : [{ metric, value }];
	});
	if (errors.length === 0 && acceptance_rate === null) return null;
	return (
		<div className="space-y-1">
			<Label>{t("smartEstimation:calibration.qualityTitle")}</Label>
			<ul className="space-y-1 text-sm text-muted-foreground">
				{errors.map(({ metric, value }) => (
					<li key={metric}>
						{t("smartEstimation:calibration.mape", {
							metric: metricLabel(metric),
							percent: percent(value),
						})}
					</li>
				))}
				{acceptance_rate !== null && (
					<li>
						{t("smartEstimation:calibration.acceptance", {
							percent: percent(acceptance_rate),
						})}
					</li>
				)}
				{mean_interval_width !== null && (
					<li>
						{t("smartEstimation:calibration.intervalWidth", {
							percent: percent(mean_interval_width),
						})}
					</li>
				)}
			</ul>
		</div>
	);
}
