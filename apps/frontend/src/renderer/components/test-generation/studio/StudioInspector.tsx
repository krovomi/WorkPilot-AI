import { Check, Copy, FileCode2, Loader2, Sparkles, TriangleAlert, Zap } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { testStudioLanguage } from "../../../../shared/constants/test-studio-languages";
import type { TestLibrarySelection } from "../../../../shared/types/test-generation";
import {
	countAssertions,
	type InspectorTab,
	type StudioMode,
} from "../../../lib/test-studio-steps";
import {
	type CoverageGap,
	useTestGenerationStore,
} from "../../../stores/test-generation-store";
import { GenerationErrorPanel } from "../GenerationErrorPanel";
import { LiveCode, lineCount } from "./LiveCode";
import { copyPath } from "../../../lib/copy-path";

const PRIORITY_ACCENT: Record<CoverageGap["priority"], string> = {
	high: "var(--tg-danger)",
	medium: "var(--tg-analyze)",
	low: "var(--tg-write)",
};

interface StudioInspectorProps {
	readonly mode: StudioMode;
	readonly tab: InspectorTab;
	readonly onTab: (tab: InspectorTab) => void;
	readonly selection: TestLibrarySelection | null;
	readonly chosenLibraries: string[];
	/** The file or scenario the run is aimed at, for the stack tab. */
	readonly target: string;
	readonly onApplyTests?: (content: string, path: string) => void;
	/** From the gaps of an analysis to a unit-test run on the same file. */
	readonly onGenerateFromGaps: () => void;
}

export function tabsForMode(mode: StudioMode): InspectorTab[] {
	return mode === "analyze" ? ["gaps", "stack"] : ["code", "tests", "stack"];
}

/**
 * The third column: what the run produced. The test file as it streams in,
 * the tests it holds, the gaps an analysis found, and the stack every answer
 * was read from.
 */
export function StudioInspector(props: StudioInspectorProps) {
	const { t } = useTranslation(["testGeneration", "common"]);
	const { mode, tab } = props;
	const tabs = tabsForMode(mode);
	const current = tabs.includes(tab) ? tab : tabs[0];

	const phase = useTestGenerationStore((s) => s.phase);
	const runKind = useTestGenerationStore((s) => s.runKind);
	const result = useTestGenerationStore((s) => s.result);
	const gaps = useTestGenerationStore((s) => s.coverageGaps);
	const streamedCode = useTestGenerationStore((s) => s.streamedCode);
	const ours = runKind === mode;
	const tests = ours ? (result?.generated_tests ?? []) : [];

	return (
		<section className="tg-col" aria-label={t("studio.inspector.kicker")}>
			<div className="tg-colhead">
				<div>
					<div className="tg-kicker">{t("studio.inspector.kicker")}</div>
					<h3>{t(`studio.inspector.title.${mode}`)}</h3>
				</div>
			</div>
			<div className="tg-card tg-inspector">
				<div className="tg-tabs" role="tablist">
					{tabs.map((id) => (
						<button
							key={id}
							type="button"
							role="tab"
							className="tg-tab"
							aria-selected={current === id}
							data-testid={`test-studio-tab-${id}`}
							onClick={() => props.onTab(id)}
						>
							{t(`studio.inspector.tabs.${id}`)}
							{id === "tests" && tests.length > 0 && <b>{tests.length}</b>}
							{id === "gaps" && ours && gaps && <b>{gaps.length}</b>}
						</button>
					))}
					{current === "code" && ours && phase === "complete" && result && (
						<CodeTools
							content={result.test_file_content}
							path={result.test_file_path}
							onApply={props.onApplyTests}
						/>
					)}
				</div>

				{current === "code" && <CodePanel mode={mode} code={ours ? streamedCode : ""} />}
				{current === "tests" && <TestsPanel mode={mode} />}
				{current === "gaps" && <GapsPanel onGenerate={props.onGenerateFromGaps} />}
				{current === "stack" && (
					<StackPanel
						mode={mode}
						selection={props.selection}
						chosen={props.chosenLibraries}
						target={props.target}
					/>
				)}
			</div>
		</section>
	);
}

function CodeTools({
	content,
	path,
	onApply,
}: {
	readonly content: string;
	readonly path: string;
	readonly onApply?: (content: string, path: string) => void;
}) {
	const { t } = useTranslation("testGeneration");
	const [copied, setCopied] = useState(false);
	return (
		<div className="tg-tab-tools">
			<button
				type="button"
				className="tg-btn tg-btn-sm"
				onClick={() => {
					void navigator.clipboard?.writeText(content);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
				{copied ? t("actions.copied") : t("actions.copyAll")}
			</button>
			{onApply && (
				<button type="button" className="tg-btn tg-btn-sm" onClick={() => onApply(content, path)}>
					{t("actions.applyTests")}
				</button>
			)}
		</div>
	);
}

function Empty({ title, body }: { readonly title: string; readonly body: string }) {
	return (
		<div className="tg-empty">
			<div className="tg-ghost" aria-hidden="true">
				<i style={{ width: "62%" }} />
				<i style={{ width: "88%" }} />
				<i style={{ width: "74%" }} />
				<i style={{ width: "40%" }} />
			</div>
			<strong>{title}</strong>
			<span>{body}</span>
		</div>
	);
}

function useElapsed(): number {
	const phase = useTestGenerationStore((s) => s.phase);
	const startedAt = useTestGenerationStore((s) => s.genStartedAt);
	const endedAt = useTestGenerationStore((s) => s.genEndedAt);
	const running = phase === "generating" || phase === "analyzing";
	const [, tick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => tick((n) => n + 1), 100);
		return () => clearInterval(id);
	}, [running]);
	return startedAt ? ((endedAt ?? Date.now()) - startedAt) / 1000 : 0;
}

function CodePanel({ mode, code }: { readonly mode: StudioMode; readonly code: string }) {
	const { t } = useTranslation("testGeneration");
	const phase = useTestGenerationStore((s) => s.phase);
	const runKind = useTestGenerationStore((s) => s.runKind);
	const result = useTestGenerationStore((s) => s.result);
	const liveMeta = useTestGenerationStore((s) => s.liveMeta);
	const elapsed = useElapsed();
	const [pathCopied, setPathCopied] = useState(false);

	const ours = runKind === mode;
	if (!ours || phase === "idle") {
		return (
			<Empty
				title={t("studio.inspector.empty.codeTitle")}
				body={t(`studio.inspector.empty.code.${mode}`)}
			/>
		);
	}

	const generating = phase === "generating";
	const complete = phase === "complete";
	const text = complete && result?.test_file_content ? result.test_file_content : code;
	const path = result?.test_file_path ?? liveMeta.path;
	const fileName = path ? path.split(/[\\/]/).pop() : undefined;
	const testsCount = liveMeta.tests ?? result?.tests_generated;

	return (
		<div className="tg-panel">
			<div className="tg-codebar">
				<FileCode2 className="h-3.5 w-3.5 flex-none" style={{ color: "var(--tg-generate)" }} />
				<span className="tg-codebar-path">{fileName ?? t("studio.inspector.fileComing")}</span>
				{generating && (
					<span className="tg-live">
						<i />
						{t("live.badgeLive")}
					</span>
				)}
			</div>
			<LiveCode
				code={text}
				streaming={generating}
				placeholder={
					phase === "error" ? (
						<>
							<TriangleAlert className="h-3.5 w-3.5" />
							{t("live.noCodeGenerated")}
						</>
					) : (
						<>
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							{t("live.waiting")}
						</>
					)
				}
			/>
			<div className="tg-stats">
				<Stat label={t("live.elapsed")}>{`${elapsed.toFixed(1)} s`}</Stat>
				<Stat label={t("live.lines")} accent>
					{lineCount(text)}
				</Stat>
				<Stat label={t("live.tests")} accent>
					{testsCount ?? "—"}
				</Stat>
				<Stat label={t("live.framework")}>{liveMeta.framework ?? "—"}</Stat>
			</div>
			{complete && path && (
				<div className="tg-written" data-testid="test-studio-written">
					<Check className="h-4 w-4 flex-none" style={{ color: "var(--tg-ok)" }} />
					<span>{t("live.writtenTo")}</span>
					<code>{path}</code>
					<button
						type="button"
						className="tg-btn tg-btn-sm"
						onClick={() => {
							void copyPath(path);
							setPathCopied(true);
							setTimeout(() => setPathCopied(false), 2000);
						}}
					>
						{pathCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
						{pathCopied ? t("live.copied") : t("live.copyPath")}
					</button>
				</div>
			)}
			{phase === "error" && (
				<div className="tg-panel-scroll" style={{ flex: "none", maxHeight: "45%" }}>
					<GenerationErrorPanel />
				</div>
			)}
		</div>
	);
}

function Stat({
	label,
	accent,
	children,
}: {
	readonly label: string;
	readonly accent?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<div className="tg-stat" data-accent={accent ? "true" : "false"}>
			<b>{children}</b>
			<span>{label}</span>
		</div>
	);
}

/** The last segment of a path, Windows or POSIX: rows name the file, the tooltip the path. */
function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TestsPanel({ mode }: { readonly mode: StudioMode }) {
	const { t } = useTranslation("testGeneration");
	const runKind = useTestGenerationStore((s) => s.runKind);
	const result = useTestGenerationStore((s) => s.result);
	const tests = runKind === mode ? (result?.generated_tests ?? []) : [];

	if (tests.length === 0) {
		return (
			<Empty
				title={t("studio.inspector.empty.testsTitle")}
				body={t("studio.inspector.empty.tests")}
			/>
		);
	}
	return (
		<div className="tg-panel-scroll">
			{tests.map((test) => {
				const asserts = countAssertions(test.test_code);
				return (
					<article
						key={test.test_name}
						className="tg-row"
						style={{ ["--tg-accent" as string]: "var(--tg-write)" }}
					>
						<div className="tg-row-head">
							<Check className="h-3.5 w-3.5 flex-none" style={{ color: "var(--tg-write)" }} />
							<span className="tg-row-name">{test.test_name}</span>
							<span className="tg-chip">{test.test_type}</span>
						</div>
						{test.description && <p>{test.description}</p>}
						<div className="tg-row-meta">
							{test.target_function && (
								<span title={test.target_function}>→ {fileName(test.target_function)}</span>
							)}
							{asserts > 0 && <span>{t("studio.inspector.assertions", { count: asserts })}</span>}
						</div>
						{test.test_code?.trim() && (
							<details>
								<summary>{t("live.viewCode")}</summary>
								<pre>{test.test_code}</pre>
							</details>
						)}
					</article>
				);
			})}
		</div>
	);
}

function GapsPanel({ onGenerate }: { readonly onGenerate: () => void }) {
	const { t } = useTranslation("testGeneration");
	const phase = useTestGenerationStore((s) => s.phase);
	const runKind = useTestGenerationStore((s) => s.runKind);
	const gaps = useTestGenerationStore((s) => s.coverageGaps);
	const ours = runKind === "analyze";

	if (ours && phase === "error") {
		return (
			<div className="tg-panel-scroll">
				<GenerationErrorPanel />
			</div>
		);
	}
	if (ours && phase === "analyzing") {
		return (
			<div className="tg-empty">
				<Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--tg-analyze)" }} />
				<strong>{t("studio.inspector.analyzingTitle")}</strong>
				<span>{t("studio.inspector.analyzing")}</span>
			</div>
		);
	}
	if (!ours || !gaps) {
		return (
			<Empty title={t("studio.inspector.empty.gapsTitle")} body={t("studio.inspector.empty.gaps")} />
		);
	}
	if (gaps.length === 0) {
		return (
			<div className="tg-empty">
				<Sparkles className="h-5 w-5" style={{ color: "var(--tg-write)" }} />
				<strong>{t("coverage.noGaps")}</strong>
				<span>{t("studio.inspector.noGapsBody")}</span>
			</div>
		);
	}

	const count = (priority: CoverageGap["priority"]) =>
		gaps.filter((gap) => gap.priority === priority).length;
	const suggested = gaps.reduce((sum, gap) => sum + (gap.suggested_test_count || 0), 0);

	return (
		<div className="tg-panel-scroll">
			<div className="tg-gap-summary">
				{(["high", "medium", "low"] as const).map((priority) => (
					<div
						key={priority}
						className="tg-gap-count"
						style={{ ["--tg-accent" as string]: PRIORITY_ACCENT[priority] }}
					>
						<b>{count(priority)}</b>
						<span>{t(`coverage.priority.${priority}`)}</span>
					</div>
				))}
			</div>
			{gaps.map((gap) => (
				<article
					key={`${gap.function.full_name || gap.function.name}-${gap.function.line_number}`}
					className="tg-row"
					style={{ ["--tg-accent" as string]: PRIORITY_ACCENT[gap.priority] }}
				>
					<div className="tg-row-head">
						<span className="tg-row-name">{gap.function.full_name || gap.function.name}</span>
						<span className="tg-priority">{t(`studio.inspector.priority.${gap.priority}`)}</span>
					</div>
					{gap.reason && <p>{gap.reason}</p>}
					<div className="tg-row-meta">
						{gap.function.line_number > 0 && (
							<span>{t("studio.inspector.line", { line: gap.function.line_number })}</span>
						)}
						<span>{t("studio.inspector.suggested", { count: gap.suggested_test_count })}</span>
					</div>
				</article>
			))}
			<button
				type="button"
				className="tg-btn tg-btn-primary"
				style={{ alignSelf: "flex-start", ["--tg-mode" as string]: "var(--tg-unit)" }}
				data-testid="test-studio-generate-from-gaps"
				onClick={onGenerate}
			>
				<Zap className="h-3.5 w-3.5" />
				{t("studio.inspector.generateFromGaps", { count: suggested })}
			</button>
		</div>
	);
}

function StackPanel({
	mode,
	selection,
	chosen,
	target,
}: {
	readonly mode: StudioMode;
	readonly selection: TestLibrarySelection | null;
	readonly chosen: string[];
	readonly target: string;
}) {
	const { t } = useTranslation("testGeneration");
	const runKind = useTestGenerationStore((s) => s.runKind);
	const liveMeta = useTestGenerationStore((s) => s.liveMeta);
	const result = useTestGenerationStore((s) => s.result);
	const ours = runKind === mode;

	const languageId = (ours && liveMeta.language) || selection?.language;
	const language = testStudioLanguage(languageId)?.label ?? languageId;
	const names = (selection?.libraries ?? [])
		.filter((library) => chosen.includes(library.id))
		.map((library) => library.name);
	const path = ours ? (result?.test_file_path ?? liveMeta.path) : undefined;

	return (
		<div className="tg-panel-scroll">
			<dl className="tg-facts">
				<dt>{t("studio.inspector.facts.target")}</dt>
				<dd className="tg-mono">{target || "—"}</dd>
				<dt>{t("studio.inspector.facts.language")}</dt>
				<dd>{language || t("studio.inspector.facts.fromProject")}</dd>
				{mode !== "analyze" && (
					<>
						<dt>{t("studio.inspector.facts.framework")}</dt>
						<dd>{(ours && liveMeta.framework) || t("studio.inspector.facts.atRun")}</dd>
						<dt>{t("studio.inspector.facts.libraries")}</dt>
						<dd>{names.length ? names.join(" · ") : "—"}</dd>
						<dt>{t("studio.inspector.facts.destination")}</dt>
						<dd className="tg-mono">{path || t("studio.inspector.facts.destinationLater")}</dd>
					</>
				)}
			</dl>
			<div className="tg-banner">
				<Sparkles className="h-4 w-4 flex-none" style={{ color: "var(--tg-input)" }} />
				<span>{t("studio.inspector.stackNote")}</span>
			</div>
		</div>
	);
}
