import { FlaskConical, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";
import { CharterButton, Chip, EmptyStage, Panel, ScanLine, Section, type Tone } from "../charter";

const STATUS_TONES: Record<string, Tone> = {
	passed: "green",
	failed: "red",
	skipped: "amber",
	error: "red",
};

interface TestRunnerTabProps {
	readonly projectPath: string;
}

/** The project's E2E tests, of every stack, run and reported file by file. */
export function TestRunnerTab({ projectPath }: TestRunnerTabProps) {
	const { t } = useTranslation(["browserAgent"]);
	const { recentTestRun, isRunningTests, runTests } = useBrowserAgentStore();

	return (
		<Section
			kicker={t("browserAgent:tabs.testRunner")}
			title={
				recentTestRun
					? t("browserAgent:tests.summary", {
							passed: recentTestRun.passed,
							failed: recentTestRun.failed,
							skipped: recentTestRun.skipped,
						})
					: t("browserAgent:tests.noResultsTitle")
			}
			meta={recentTestRun ? t("browserAgent:tests.seconds", { value: (recentTestRun.durationMs / 1000).toFixed(1) }) : undefined}
			actions={
				<CharterButton
					variant="primary"
					icon={Play}
					busy={isRunningTests}
					onClick={() => runTests(projectPath)}
					disabled={isRunningTests}
				>
					{isRunningTests ? t("browserAgent:tests.running") : t("browserAgent:tests.runAll")}
				</CharterButton>
			}
		>
			{isRunningTests && <ScanLine label={t("browserAgent:tests.running")} />}
			{!recentTestRun && !isRunningTests && (
				<EmptyStage icon={FlaskConical} tone="green" title={t("browserAgent:tests.noResultsTitle")}>
					{t("browserAgent:tests.noResults")}
				</EmptyStage>
			)}
			{recentTestRun && (
				<div className="grid gap-2">
					{recentTestRun.results.map((result) => {
						const tone = STATUS_TONES[result.status] ?? "muted";
						return (
							<Panel key={`${result.path}:${result.name}`} rail tone={tone}>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="wp-title truncate text-sm">{result.name}</p>
										<p className="wp-meta truncate font-mono">{result.path}</p>
									</div>
									<span className="flex shrink-0 items-center gap-2">
										<span className="wp-meta font-mono">
											{t("browserAgent:tests.milliseconds", { value: result.durationMs.toFixed(0) })}
										</span>
										<Chip tone={tone}>
											{t(`browserAgent:tests.${result.status}`, { defaultValue: result.status })}
										</Chip>
									</span>
								</div>
								{result.errorMessage && (
									<details className="mt-2">
										<summary className="wp-meta cursor-pointer">{t("browserAgent:tests.errorDetails")}</summary>
										<pre className="wp-code mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
											{result.errorMessage}
										</pre>
									</details>
								)}
							</Panel>
						);
					})}
				</div>
			)}
		</Section>
	);
}
