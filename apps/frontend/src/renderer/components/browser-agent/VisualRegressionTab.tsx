import { Bookmark, GitCompareArrows, ScanEye, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";
import { formatAppDate } from "@/lib/date-format";
import { Bar, CharterButton, Chip, EmptyStage, Panel, Section, type Tone } from "../charter";

interface VisualRegressionTabProps {
	readonly projectPath: string;
}

const matchTone = (value: number): Tone => (value >= 95 ? "green" : value >= 85 ? "amber" : "red");

/** Screenshots turned into baselines, then compared pixel by pixel. */
export function VisualRegressionTab({ projectPath }: VisualRegressionTabProps) {
	const { t } = useTranslation(["browserAgent"]);
	const {
		baselines,
		comparisons,
		screenshots,
		isComparing,
		isLoading,
		setBaseline,
		compareScreenshot,
		deleteBaseline,
	} = useBrowserAgentStore();

	const handleSetBaseline = async (name: string) => {
		const screenshot = screenshots.find((s) => s.name === name);
		await setBaseline(projectPath, name, screenshot?.path);
	};

	if (baselines.length === 0 && screenshots.length === 0) {
		return (
			<EmptyStage icon={ScanEye} tone="violet" title={t("browserAgent:regression.noBaselinesTitle")}>
				{t("browserAgent:regression.noBaselines")}
			</EmptyStage>
		);
	}

	return (
		<div className="space-y-4">
			{comparisons.length > 0 && (
				<Section kicker={t("browserAgent:regression.kicker")} title={t("browserAgent:regression.resultsTitle")}>
					<div className="grid gap-2.5 lg:grid-cols-2">
						{comparisons.map((comparison) => {
							const tone: Tone = comparison.passed ? "green" : "red";
							return (
								<Panel key={comparison.name} rail tone={tone}>
									<div className="flex items-center justify-between gap-2">
										<span className="wp-title truncate text-sm">{comparison.name}</span>
										<Chip tone={tone}>
											{comparison.passed
												? t("browserAgent:regression.passed")
												: t("browserAgent:regression.failed")}
										</Chip>
									</div>
									<div className="mt-2 flex items-center gap-3">
										<div className="flex-1">
											<Bar value={comparison.matchPercentage} tone={matchTone(comparison.matchPercentage)} />
										</div>
										<span className="wp-meta font-mono">
											{t("browserAgent:regression.matchValue", { value: comparison.matchPercentage })}
										</span>
									</div>
									<p className="wp-meta mt-1.5">
										{t("browserAgent:regression.diffSummary", {
											pixels: comparison.diffPixels.toLocaleString(),
											threshold: comparison.threshold,
										})}
									</p>
								</Panel>
							);
						})}
					</div>
				</Section>
			)}

			{baselines.length > 0 && (
				<Section
					kicker={t("browserAgent:regression.baselinesKicker")}
					title={t("browserAgent:regression.baselinesTitle", { count: baselines.length })}
				>
					<div className="grid gap-2.5 lg:grid-cols-2">
						{baselines.map((baseline) => (
							<Panel key={baseline.name} rail tone="amber">
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0">
										<p className="wp-title truncate text-sm">{baseline.name}</p>
										<p className="wp-meta">
											{t("browserAgent:regression.sizeAndDate", {
												width: baseline.width,
												height: baseline.height,
												date: formatAppDate(baseline.createdAt),
											})}
										</p>
									</div>
									<span className="flex shrink-0 gap-1.5">
										<CharterButton
											size="sm"
											icon={GitCompareArrows}
											busy={isComparing}
											onClick={() => void compareScreenshot(projectPath, baseline.name)}
											disabled={isComparing}
										>
											{t("browserAgent:regression.compare")}
										</CharterButton>
										<CharterButton
											size="sm"
											variant="ghost"
											icon={Trash2}
											onClick={() => deleteBaseline(projectPath, baseline.name)}
											disabled={isLoading}
										>
											{t("browserAgent:regression.deleteBaseline")}
										</CharterButton>
									</span>
								</div>
							</Panel>
						))}
					</div>
				</Section>
			)}

			{screenshots.length > 0 && (
				<Section
					kicker={t("browserAgent:regression.screenshotsKicker")}
					title={t("browserAgent:regression.screenshotsTitle", { count: screenshots.length })}
				>
					<div className="grid gap-2.5 lg:grid-cols-2">
						{screenshots.slice(0, 10).map((screenshot) => {
							const hasBaseline = baselines.some((b) => b.name === screenshot.name);
							return (
								<Panel key={screenshot.path} rail tone="blue">
									<div className="flex items-center justify-between gap-2">
										<div className="min-w-0">
											<p className="wp-title truncate text-sm">{screenshot.name}</p>
											<p className="wp-meta">
												{t("browserAgent:regression.size", {
													width: screenshot.width,
													height: screenshot.height,
												})}
											</p>
										</div>
										{hasBaseline ? (
											<CharterButton
												size="sm"
												icon={GitCompareArrows}
												busy={isComparing}
												onClick={() => void compareScreenshot(projectPath, screenshot.name)}
												disabled={isComparing}
											>
												{t("browserAgent:regression.compare")}
											</CharterButton>
										) : (
											<CharterButton
												size="sm"
												icon={Bookmark}
												onClick={() => void handleSetBaseline(screenshot.name)}
												disabled={isLoading}
											>
												{t("browserAgent:regression.setBaseline")}
											</CharterButton>
										)}
									</div>
								</Panel>
							);
						})}
					</div>
				</Section>
			)}
		</div>
	);
}
