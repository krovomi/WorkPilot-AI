import { Bug, FileCode, ShieldOff, TrendingDown, TrendingUp, Wrench } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { FlakyConfidence, FlakyTest, FlakyVerdict } from "../../../shared/types/flaky-tests";
import { useProjectStore } from "../../stores/project-store";
import { createTask } from "../../stores/task-store";
import { CharterButton, Chip, Notice, Panel, type Tone } from "../charter";
import { buildFlakyTask, type FlakyTaskKind } from "./flaky-task";

type T = (key: string, opts?: Record<string, unknown>) => string;

const CONFIDENCE_TONE: Record<FlakyConfidence, Tone> = {
	high: "red",
	medium: "amber",
	low: "muted",
};

const VERDICT_TONE: Record<FlakyVerdict, Tone> = {
	likely_bug: "red",
	flaky: "amber",
	rare: "blue",
};

/** One flaky test: what failed, what its code shows, its history, and what to do about it. */
export function FlakyTestCard({
	test,
	projectPath,
	t,
}: {
	readonly test: FlakyTest;
	readonly projectPath?: string;
	readonly t: T;
}): React.ReactElement {
	const [busy, setBusy] = useState<FlakyTaskKind | null>(null);
	const [created, setCreated] = useState<{ id: string; title: string } | null>(null);
	const [failed, setFailed] = useState(false);
	const history = test.history;

	const createCard = async (kind: FlakyTaskKind): Promise<void> => {
		const projects = useProjectStore.getState();
		const projectId =
			projects.projects.find((project) => project.path === projectPath)?.id ?? projects.activeProjectId ?? null;
		if (!projectId || busy) return;
		setBusy(kind);
		setFailed(false);
		try {
			const spec = buildFlakyTask(test, kind, t);
			const task = await createTask(projectId, spec.title, spec.description, {
				sourceType: "flaky-tests",
				acceptanceCriteria: spec.acceptanceCriteria,
			});
			if (task) setCreated({ id: task.id, title: task.title });
			else setFailed(true);
		} finally {
			setBusy(null);
		}
	};

	const openCard = (): void => {
		if (!created) return;
		globalThis.dispatchEvent(
			new CustomEvent("workpilot:navigate-view", { detail: { view: "kanban", taskId: created.id } }),
		);
	};

	return (
		<Panel rail tone={CONFIDENCE_TONE[test.confidence]}>
			<div className="mb-1 flex items-start justify-between gap-3">
				<p className="wp-mono break-all text-sm font-medium">{test.testName}</p>
				<div className="flex shrink-0 flex-wrap justify-end gap-1">
					{test.verdict && (
						<Chip tone={VERDICT_TONE[test.verdict]} title={t(`verdict.${test.verdict}`)}>
							{t(`verdictShort.${test.verdict}`)}
						</Chip>
					)}
					<Chip tone={CONFIDENCE_TONE[test.confidence]}>{t(`confidenceLevel.${test.confidence}`)}</Chip>
				</div>
			</div>
			<div className="wp-meta flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-normal">
				<span>
					{t("failedRuns", {
						failures: test.failures,
						total: test.totalRuns,
						rate: (test.flakinessRate * 100).toFixed(0),
					})}
				</span>
				<span>
					{t("cause")} {t(`causes.${test.probableCause}`)}
				</span>
				{test.file && (
					<span className="inline-flex items-center gap-1 font-mono">
						<FileCode className="h-3 w-3" aria-hidden="true" />
						{test.file}:{test.line}
					</span>
				)}
				{test.lastAuthor && <span>{t("task.lastAuthor", { author: test.lastAuthor })}</span>}
			</div>

			{test.verdict === "likely_bug" && (
				<p className="mt-2 text-xs text-destructive">{t("verdict.likely_bug")}</p>
			)}
			<p className="mt-2 text-xs text-success">{t(`fixes.${test.probableCause}`)}</p>

			{(test.sourceCauses ?? []).length > 0 && (
				<div className="mt-2 flex flex-col gap-1.5">
					<p className="wp-kicker">{t("inCode")}</p>
					{(test.sourceCauses ?? []).map((cause) => (
						<div key={cause.cause} className="text-xs">
							<Chip tone="amber" dot={false}>
								{t(`causes.${cause.cause}`)}
							</Chip>
							<ul className="mt-1 space-y-0.5">
								{cause.evidence.map((proof) => (
									<li key={`${cause.cause}-${proof.line}`} className="wp-code !py-0.5 break-all">
										<span className="wp-faint select-none">{proof.line} </span>
										{proof.text}
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			)}

			{history && history.observations > 0 && (
				<div className="wp-meta mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-normal">
					{history.firstSeen && <span>{t("history.firstSeen", { date: history.firstSeen.slice(0, 10) })}</span>}
					<span className="inline-flex items-center gap-1">
						{history.trend === "worse" && <TrendingUp className="h-3 w-3 text-destructive" aria-hidden="true" />}
						{history.trend === "better" && <TrendingDown className="h-3 w-3 text-success" aria-hidden="true" />}
						{t(`history.trend.${history.trend}`)}
					</span>
					{history.systems.length > 0 && <span>{t("history.systems", { systems: history.systems.join(", ") })}</span>}
					{history.ciOnly && <Chip tone="violet">{t("history.ciOnlyShort")}</Chip>}
				</div>
			)}

			{test.errorPatterns[0] && (
				<details className="mt-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">{t("errorSample")}</summary>
					<pre className="wp-code mt-1">{test.errorPatterns[0]}</pre>
				</details>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-2">
				<CharterButton
					size="sm"
					icon={test.verdict === "likely_bug" ? Bug : Wrench}
					busy={busy === "fix"}
					disabled={Boolean(busy) || !projectPath}
					onClick={() => void createCard("fix")}
				>
					{t("actions.fix")}
				</CharterButton>
				<CharterButton
					size="sm"
					variant="ghost"
					icon={ShieldOff}
					busy={busy === "quarantine"}
					disabled={Boolean(busy) || !projectPath}
					onClick={() => void createCard("quarantine")}
				>
					{t("actions.quarantine")}
				</CharterButton>
			</div>
			{created && (
				<Notice tone="green" role="status" className="mt-2">
					<span className="break-words">{t("task.created", { title: created.title })}</span>{" "}
					<button type="button" className="underline" onClick={openCard}>
						{t("task.open")}
					</button>
				</Notice>
			)}
			{failed && (
				<Notice tone="red" role="alert" className="mt-2">
					{t("task.failed")}
				</Notice>
			)}
		</Panel>
	);
}
