import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesignStep } from "../../../lib/design-import-steps";
import { useDesignToCodeStore } from "../../../stores/design-to-code-store";
import { useProjectStore } from "../../../stores/project-store";
import { GeneratedReviewBanner } from "../../generated-review/GeneratedReviewBanner";

const ACCENT: Record<DesignStep, string> = {
	vision: "var(--di-vision)",
	tokens: "var(--di-tokens)",
	spec: "var(--di-spec)",
	code: "var(--di-code)",
	tests: "var(--di-tests)",
	project: "var(--di-project)",
};

interface FileEntry {
	path: string;
	content: string;
	language: string;
	exists?: boolean;
	kind: "code" | "test";
}

function Header({ step, title }: { step: DesignStep | "live" | "empty"; title: string }) {
	const { t } = useTranslation("designToCode");
	const accent = step === "live" || step === "empty" ? "var(--di-faint)" : ACCENT[step];
	const kicker =
		step === "live"
			? t("inspector.live")
			: step === "empty"
				? t("inspector.kicker")
				: t(`steps.${step}.kicker`);
	return (
		<div className="di-colhead">
			<div>
				<div className="di-kicker" style={{ ["--di-accent" as string]: accent }}>
					{kicker}
				</div>
				<h2>{title}</h2>
			</div>
		</div>
	);
}

function FilesView({ files, accent }: { files: FileEntry[]; accent: string }) {
	const { t } = useTranslation("designToCode");
	const selected = useDesignToCodeStore((s) => s.selectedFilePath);
	const selectFile = useDesignToCodeStore((s) => s.selectFile);
	const [copied, setCopied] = useState<string | null>(null);
	const current = files.find((f) => f.path === selected) ?? files[0];

	const groups = new Map<string, FileEntry[]>();
	for (const file of files) {
		const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
		groups.set(dir, [...(groups.get(dir) ?? []), file]);
	}

	const copy = async (file: FileEntry) => {
		try {
			await navigator.clipboard.writeText(file.content);
			setCopied(file.path);
			setTimeout(() => setCopied(null), 1600);
		} catch {
			/* clipboard refused: nothing to show */
		}
	};

	return (
		<div className="di-card di-files" style={{ ["--di-accent" as string]: accent }}>
			<div className="di-file-list">
				{[...groups.entries()].map(([dir, entries]) => (
					<div key={dir}>
						<div className="di-group-label" title={dir}>
							{dir}
						</div>
						{entries.map((file) => (
							<button
								key={file.path}
								type="button"
								className="di-file"
								data-selected={current?.path === file.path}
								onClick={() => selectFile(file.path)}
							>
								<span className="di-file-dot" />
								<span className="di-file-name">{file.path.split("/").pop()}</span>
								<span
									className="di-file-tag"
									data-kind={file.exists ? "exists" : "new"}
									title={t(file.exists ? "inspector.fileExistsHint" : "inspector.fileNewHint")}
								>
									{t(file.exists ? "inspector.fileExists" : "inspector.fileNew")}
								</span>
							</button>
						))}
					</div>
				))}
			</div>
			{current && (
				<div className="di-code">
					<div className="di-code-bar">
						<span className="di-code-path" title={current.path}>
							{current.path}
						</span>
						<button type="button" className="di-btn ml-auto" onClick={() => copy(current)}>
							{copied === current.path ? (
								<Check className="h-3 w-3" />
							) : (
								<Copy className="h-3 w-3" />
							)}
							{t(copied === current.path ? "code.copied" : "code.copy")}
						</button>
					</div>
					<pre data-testid="design-code-view">{current.content}</pre>
				</div>
			)}
		</div>
	);
}

/**
 * The right column: nothing before a run, the analysis as it arrives during
 * one, and afterwards the result of the step picked in the pipeline.
 */
export function ResultInspector() {
	const { t } = useTranslation("designToCode");
	const phase = useDesignToCodeStore((s) => s.phase);
	const result = useDesignToCodeStore((s) => s.result);
	const live = useDesignToCodeStore((s) => s.live);
	const journal = useDesignToCodeStore((s) => s.journal);
	const startedAt = useDesignToCodeStore((s) => s.startedAt);
	const selectedStep = useDesignToCodeStore((s) => s.selectedStep);
	const error = useDesignToCodeStore((s) => s.error);
	const writeOutcome = useDesignToCodeStore((s) => s.writeOutcome);
	const projectId = useProjectStore((s) => s.selectedProjectId);
	const running = !["idle", "complete", "error"].includes(phase);

	const banners = (
		<>
			{error && (
				<div className="di-banner mb-3" data-kind="error" role="alert">
					{error === "missing_input" ? t("errors.missingInput") : error}
				</div>
			)}
			{result?.simulated && (
				<div className="di-banner mb-3" role="status" data-testid="design-simulated">
					{t("inspector.simulated")}
				</div>
			)}
			{result?.accessibility && (
				<div
					className="di-banner mb-3"
					data-kind={result.accessibility.count ? "error" : undefined}
					role="status"
					data-testid="design-accessibility"
				>
					{result.accessibility.count
						? t("inspector.accessibility", {
								score: result.accessibility.score,
								count: result.accessibility.count,
								rules: [...new Set(result.accessibility.violations.map((v) => v.ruleId))].slice(0, 4).join(", "),
							})
						: t("inspector.accessibilityClean", { level: result.accessibility.targetLevel })}
				</div>
			)}
		</>
	);

	if (running || (phase === "error" && !result)) {
		const components = live.spec?.components ?? [];
		return (
			<section className="di-col" aria-label={t("inspector.live")}>
				<Header step="live" title={t("inspector.liveTitle")} />
				{banners}
				<div className="di-card di-inspector p-4">
					{components.length > 0 ? (
						<ul className="di-tree" data-testid="design-live-tree">
							{components.map((c) => (
								<li key={c.name}>
									<span className="di-tree-name">{c.name}</span>{" "}
									<span className="di-faint">{c.type}</span>
									{c.children.length > 0 && (
										<span className="di-faint"> · {c.children.join(", ")}</span>
									)}
								</li>
							))}
						</ul>
					) : (
						<div className="di-muted text-xs">{t("inspector.waitingVision")}</div>
					)}
					<div className="di-kicker mt-5 mb-2" style={{ ["--di-accent" as string]: "var(--di-faint)" }}>
						{t("inspector.journal")}
					</div>
					<ul className="di-journal">
						{journal.map((entry) => (
							<li key={`${entry.phase}-${entry.at}`}>
								<span>{t(`phases.${entry.phase}`)}</span>
								{startedAt && (
									<time>{t("inspector.elapsed", { seconds: Math.max(0, Math.round((entry.at - startedAt) / 1000)) })}</time>
								)}
							</li>
						))}
					</ul>
				</div>
			</section>
		);
	}

	if (!result) {
		return (
			<section className="di-col" aria-label={t("inspector.kicker")}>
				<Header step="empty" title={t("inspector.emptyTitle")} />
				{banners}
				<div className="di-card di-inspector">
					<div className="di-empty">
						<div className="di-ghost" aria-hidden="true">
							<i style={{ width: "40%" }} />
							<i style={{ width: "85%" }} />
							<i style={{ width: "70%" }} />
							<i style={{ width: "78%" }} />
							<i style={{ width: "52%" }} />
						</div>
						<strong className="text-sm">{t("inspector.emptyLead")}</strong>
						<span>{t("inspector.emptyBody")}</span>
					</div>
				</div>
			</section>
		);
	}

	const step: DesignStep = selectedStep ?? "code";
	const codeFiles: FileEntry[] = result.generated_files.map((f) => ({ ...f, kind: "code" }));
	const testFiles: FileEntry[] = result.visual_tests.map((v) => ({
		path: v.path || `tests/visual/${v.name}`,
		content: v.test_code,
		language: "test",
		exists: v.exists,
		kind: "test",
	}));
	const spec = result.design_spec;

	const summary = (
		<div className="mb-3 flex flex-wrap gap-2">
			<span className="di-chip" style={{ ["--di-accent" as string]: "var(--di-code)" }}>
				<i />
				{t("inspector.files", { count: codeFiles.length })}
			</span>
			<span className="di-chip" style={{ ["--di-accent" as string]: "var(--di-tokens)" }}>
				<i />
				{t("inspector.tokens", { count: result.design_tokens_used.length })}
			</span>
			<span className="di-chip" style={{ ["--di-accent" as string]: "var(--di-tests)" }}>
				<i />
				{t("inspector.tests", { count: testFiles.length })}
			</span>
			<span className="di-chip">
				<i />
				{t("inspector.duration", { seconds: result.duration_seconds.toFixed(0) })}
			</span>
		</div>
	);

	let body: React.ReactNode;
	let title: string;
	switch (step) {
		case "vision":
		case "spec":
			title = t("inspector.specTitle", { count: spec?.components.length ?? 0 });
			body = (
				<div className="di-card di-inspector overflow-auto p-4">
					<ul className="di-tree">
						{(spec?.components ?? []).map((c) => (
							<li key={c.name}>
								<span className="di-tree-name">{c.name}</span> <span className="di-faint">{c.type}</span>
								{c.description && <div className="di-muted pl-4 font-sans text-xs">{c.description}</div>}
								{c.children.length > 0 && (
									<div className="di-faint pl-4">{c.children.map((ch) => ch.name).join(", ")}</div>
								)}
							</li>
						))}
					</ul>
				</div>
			);
			break;
		case "tokens":
			title = t("inspector.tokensTitle", { count: result.design_tokens_used.length });
			body = (
				<div className="di-card di-inspector overflow-auto p-4">
					{result.design_tokens_used.length === 0 ? (
						<div className="di-muted text-xs">{t("inspector.noTokens")}</div>
					) : (
						<ul className="di-tree">
							{result.design_tokens_used.map((token) => (
								<li key={token.name} className="flex items-center gap-2">
									{token.category === "color" && (
										<i
											className="inline-block h-3 w-3 rounded-sm border"
											style={{ background: token.value }}
										/>
									)}
									<span className="di-tree-name">{token.name}</span>
									<span className="di-faint truncate">{token.value}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			);
			break;
		case "tests":
			title = t("inspector.testsTitle", { count: testFiles.length });
			body =
				testFiles.length > 0 ? (
					<FilesView files={testFiles} accent="var(--di-tests)" />
				) : (
					<div className="di-card di-inspector">
						<div className="di-empty">
							{result.warnings.includes("visual_tests_unsupported")
								? t("pipeline.testsUnsupported")
								: t("inspector.noTests")}
						</div>
					</div>
				);
			break;
		case "project":
			title = t(writeOutcome ? "inspector.writtenTitle" : "inspector.projectTitle");
			body = (
				<div className="di-card di-inspector overflow-auto p-4">
					{writeOutcome?.review && (
						<GeneratedReviewBanner
							key={writeOutcome.review.taskId}
							review={writeOutcome.review}
							projectId={projectId ?? undefined}
							className="mb-3"
						/>
					)}
					{writeOutcome ? (
						<ul className="di-journal">
							{writeOutcome.written.map((w) => (
								<li key={w.path}>
									<span className="di-mono">{w.path}</span>
									<time>{t(w.created ? "inspector.created" : "inspector.updated")}</time>
								</li>
							))}
							{writeOutcome.refused.map((r) => (
								<li key={`refused-${r.path}`}>
									<span className="di-mono">{r.path}</span>
									<time>{t(`inspector.refused.${r.reason}`)}</time>
								</li>
							))}
						</ul>
					) : (
						<div className="di-muted text-xs leading-relaxed">{t("inspector.projectBody")}</div>
					)}
				</div>
			);
			break;
		default:
			title = t("inspector.codeTitle", { count: codeFiles.length });
			body = <FilesView files={codeFiles} accent="var(--di-code)" />;
	}

	return (
		<section className="di-col" aria-label={t("inspector.kicker")}>
			<Header step={step} title={title} />
			{banners}
			{summary}
			{body}
		</section>
	);
}
