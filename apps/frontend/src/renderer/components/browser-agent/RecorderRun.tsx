import type { RecordedStep } from "@shared/types/browser-recorder";
import type { RecordedTestRun, ReshootStep } from "@shared/types/browser-recorder-run";
import { CheckCircle2, Play, ScanSearch, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useBrowserRecorderStore } from "@/stores/browser-recorder-store";
import { CharterButton, Chip, Notice, Panel } from "../charter";
import { selectorSummary } from "./recorder-steps";

const TONES = { ok: "green", changed: "amber", missing: "red", failed: "red", "not-reached": "blue" } as const;

function RunResult({ run }: { readonly run: RecordedTestRun }) {
	const { t } = useTranslation(["browserAgent"]);
	return (
		<div className="space-y-2" data-testid="recorder-run-result">
			<Notice tone={run.passed ? "green" : "red"} icon={run.passed ? CheckCircle2 : XCircle}>
				{run.passed
					? t("browserAgent:recorder.run.passed")
					: t("browserAgent:recorder.run.failed", { code: run.exitCode ?? "—" })}
			</Notice>
			{run.setup === "awaiting-approval" && (
				<Notice tone="amber">{t("browserAgent:recorder.run.awaitingApproval")}</Notice>
			)}
			<p className="wp-meta flex flex-wrap gap-1">
				{run.firstRun && <span>{t("browserAgent:recorder.run.firstRun")}</span>}
				<span>{t("browserAgent:recorder.run.rate", { passed: run.firstPassed, runs: run.firstRuns })}</span>
			</p>
			{run.output && (
				<pre className="max-h-64 overflow-auto rounded-md bg-[var(--wp-code-bg)] p-3 font-mono text-xs">
					{run.output}
				</pre>
			)}
		</div>
	);
}

function ReshootList({
	shots,
	steps,
	applied,
	onApply,
}: {
	readonly shots: readonly ReshootStep[];
	readonly steps: readonly RecordedStep[];
	readonly applied: readonly string[];
	readonly onApply: (ids: string[]) => void;
}) {
	const { t } = useTranslation(["browserAgent"]);
	const changed = shots.filter((shot) => shot.status === "changed" && !applied.includes(shot.id));
	const [picked, setPicked] = useState<string[]>(() => changed.map((shot) => shot.id));
	if (!shots.length) return <p className="wp-meta">{t("browserAgent:recorder.reshoot.empty")}</p>;
	return (
		<div className="space-y-2">
			<ol className="space-y-1.5" data-testid="recorder-reshoot">
				{shots.map((shot) => {
					const step = steps.find((s) => s.id === shot.id);
					const proposal = shot.selectors && step ? selectorSummary({ ...step, selectors: shot.selectors }) : "";
					const done = applied.includes(shot.id);
					return (
						<li key={shot.id} className="flex items-center gap-2 text-sm">
							<Chip tone={TONES[shot.status]} dot={false}>
								{t(`browserAgent:recorder.reshoot.status.${shot.status}`)}
							</Chip>
							{step && <span className="wp-meta">{t(`browserAgent:recorder.kinds.${step.kind}`)}</span>}
							{step && <code className="min-w-0 truncate font-mono text-xs">{selectorSummary(step)}</code>}
							{proposal && !done && (
								<label className="ml-auto inline-flex min-w-0 items-center gap-1 text-xs">
									<input
										type="checkbox"
										checked={picked.includes(shot.id)}
										onChange={(e) =>
											setPicked((ids) =>
												e.target.checked ? [...ids, shot.id] : ids.filter((id) => id !== shot.id),
											)
										}
									/>
									<span className="wp-meta shrink-0">{t("browserAgent:recorder.reshoot.now")}</span>
									<code className="truncate font-mono">{proposal}</code>
								</label>
							)}
							{done && <span className="wp-meta ml-auto">{t("browserAgent:recorder.reshoot.applied")}</span>}
						</li>
					);
				})}
			</ol>
			{changed.length > 0 && (
				<CharterButton
					size="sm"
					variant="primary"
					disabled={!picked.some((id) => changed.some((shot) => shot.id === id))}
					onClick={() => onApply(picked.filter((id) => changed.some((shot) => shot.id === id)))}
				>
					{t("browserAgent:recorder.reshoot.apply")}
				</CharterButton>
			)}
		</div>
	);
}

/**
 * The recorded test run on its review card, and the recording replayed
 * without a window to see which selectors still find their element (#387).
 * The test's output is text; the steps change only when the person applies
 * the selectors a replay proposed.
 */
export function RecorderRun({ projectPath }: { readonly projectPath: string }) {
	const { t } = useTranslation(["browserAgent"]);
	const r = useBrowserRecorderStore(
		useShallow((s) => ({
			status: s.status,
			steps: s.steps,
			outcome: s.outcome,
			running: s.running,
			run: s.run,
			reshooting: s.reshooting,
			reshoot: s.reshoot,
			applied: s.applied,
			runTest: s.runTest,
			reshootSteps: s.reshootSteps,
			applyReshoot: s.applyReshoot,
		})),
	);
	const idle = r.status === "idle";
	if (!r.steps.length) return null;
	return (
		<Panel>
			<h3 className="wp-kicker mb-1">{t("browserAgent:recorder.check.title")}</h3>
			<p className="wp-meta mb-2">{t("browserAgent:recorder.check.hint")}</p>
			<div className="mb-3 flex flex-wrap gap-2">
				<CharterButton
					size="sm"
					icon={Play}
					disabled={!idle || !r.outcome?.review || r.running}
					busy={r.running}
					onClick={() => r.runTest(projectPath)}
				>
					{t("browserAgent:recorder.run.start")}
				</CharterButton>
				<CharterButton
					size="sm"
					icon={ScanSearch}
					disabled={!idle || r.reshooting}
					busy={r.reshooting}
					onClick={() => r.reshootSteps(projectPath)}
				>
					{t("browserAgent:recorder.reshoot.start")}
				</CharterButton>
			</div>
			<div className="space-y-3">
				{r.run && <RunResult run={r.run} />}
				{r.reshoot && (
					<ReshootList
						key={r.reshoot.map((shot) => shot.id).join()}
						shots={r.reshoot}
						steps={r.steps}
						applied={r.applied}
						onApply={(ids) => r.applyReshoot(projectPath, ids)}
					/>
				)}
			</div>
		</Panel>
	);
}
