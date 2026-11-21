import type { ExportDestination, RecordedStep, TestFormat } from "@shared/types/browser-recorder";
import { TEST_FORMATS } from "@shared/types/browser-recorder";
import {
	AlertTriangle,
	CircleDot,
	Eye,
	FileDown,
	GitPullRequest,
	Hourglass,
	KeyRound,
	Layers,
	ListX,
	Square,
	X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";
import { useBrowserRecorderStore } from "@/stores/browser-recorder-store";
import { useProjectStore } from "@/stores/project-store";
import { CharterButton, Chip, EmptyStage, Notice, Panel, Tabs } from "../charter";
import { GeneratedReviewBanner } from "../generated-review/GeneratedReviewBanner";
import { Input } from "../ui/input";

interface RecorderTabProps {
	readonly projectPath: string;
}

/** How the step finds its element, as a short line: the first, most robust selector. */
export function selectorSummary(step: RecordedStep): string {
	const selector = step.selectors[0];
	if (!selector) return step.url ?? "";
	return selector.strategy === "role"
		? `${selector.role} "${selector.value}"`
		: `${selector.strategy} "${selector.value}"`;
}

function StepDetail({ step }: { readonly step: RecordedStep }) {
	const { t } = useTranslation(["browserAgent"]);
	if (step.secretEnv) {
		return (
			<span className="wp-meta inline-flex items-center gap-1">
				<KeyRound className="h-3 w-3" aria-hidden="true" />
				{t("browserAgent:recorder.secretValue", { name: step.secretEnv })}
			</span>
		);
	}
	if (step.key) return <kbd className="wp-meta">{step.key}</kbd>;
	const detail = step.kind === "navigate" ? "" : (step.value ?? step.text);
	return detail ? <code className="wp-meta truncate">{detail}</code> : null;
}

/** Where the element lives and what the replay waits for, as short notes. */
export function StepNotes({ step }: { readonly step: RecordedStep }) {
	const { t } = useTranslation(["browserAgent"]);
	const notes = [
		...(step.frames?.length ? [{ icon: Layers, text: t("browserAgent:recorder.place.frame") }] : []),
		...(step.shadow?.length ? [{ icon: Layers, text: t("browserAgent:recorder.place.shadow") }] : []),
		...(step.waitVisible ? [{ icon: Hourglass, text: t("browserAgent:recorder.waits.visible") }] : []),
		...(step.waitRequest
			? [{ icon: Hourglass, text: t("browserAgent:recorder.waits.request", step.waitRequest) }]
			: []),
		...(step.waitUrl ? [{ icon: Hourglass, text: t("browserAgent:recorder.waits.url", { url: step.waitUrl }) }] : []),
	];
	if (!notes.length) return null;
	return (
		<span className="wp-meta inline-flex min-w-0 flex-wrap items-center gap-2" data-testid="step-notes">
			{notes.map(({ icon: Icon, text }) => (
				<span key={text} className="inline-flex min-w-0 items-center gap-1 truncate">
					<Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
					{text}
				</span>
			))}
		</span>
	);
}

/** Record what the person does in a browser window, then export it as a test (#387). */
export function RecorderTab({ projectPath }: RecorderTabProps) {
	const { t } = useTranslation(["browserAgent"]);
	const currentUrl = useBrowserAgentStore((s) => s.currentUrl);
	const projectId = useProjectStore((s) => s.selectedProjectId ?? undefined);
	const recorder = useBrowserRecorderStore(
		useShallow((s) => ({
			status: s.status,
			steps: s.steps,
			truncated: s.truncated,
			error: s.error,
			format: s.format,
			name: s.name,
			exporting: s.exporting,
			outcome: s.outcome,
			setFormat: s.setFormat,
			setName: s.setName,
			removeStep: s.removeStep,
			start: s.start,
			stop: s.stop,
			exportTo: s.exportTo,
		})),
	);
	const [url, setUrl] = useState(currentUrl);
	const idle = recorder.status === "idle";
	const canExport = idle && recorder.steps.length > 0 && recorder.exporting === null;
	const outcome = recorder.outcome;

	const exportTo = (destination: ExportDestination) => recorder.exportTo(projectPath, destination);

	return (
		<div className="space-y-4">
			<Panel>
				<p className="wp-header-desc mb-3">{t("browserAgent:recorder.description")}</p>
				<div className="flex items-center gap-2">
					<div className="wp-prompt flex-1">
						<Input
							type="url"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							aria-label={t("browserAgent:recorder.urlLabel")}
							placeholder={t("browserAgent:browser.urlPlaceholder")}
							disabled={!idle}
							className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs shadow-none focus-visible:ring-0"
						/>
					</div>
					{idle ? (
						<CharterButton
							variant="primary"
							size="sm"
							icon={CircleDot}
							disabled={!url.trim()}
							onClick={() => recorder.start(projectPath, url.trim())}
						>
							{t("browserAgent:recorder.start")}
						</CharterButton>
					) : (
						<CharterButton
							variant="danger"
							size="sm"
							icon={Square}
							busy={recorder.status !== "recording"}
							disabled={recorder.status !== "recording"}
							onClick={() => recorder.stop()}
						>
							{t("browserAgent:recorder.stop")}
						</CharterButton>
					)}
				</div>
				{!idle && (
					<div className="mt-3">
						<Chip tone="red">{t(`browserAgent:recorder.${recorder.status}`)}</Chip>
					</div>
				)}
			</Panel>

			{recorder.error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{recorder.error}
				</Notice>
			)}
			{recorder.truncated && (
				<Notice tone="amber" icon={AlertTriangle}>
					{t("browserAgent:recorder.truncated")}
				</Notice>
			)}

			<Panel>
				<h3 className="wp-kicker mb-2">{t("browserAgent:recorder.stepsTitle")}</h3>
				{recorder.steps.length === 0 ? (
					<EmptyStage icon={ListX} tone="blue" title={t("browserAgent:recorder.stepsTitle")}>
						{t("browserAgent:recorder.noSteps")}
					</EmptyStage>
				) : (
					<ol className="space-y-1.5" data-testid="recorder-steps">
						{recorder.steps.map((step) => (
							<li key={step.id} className="flex items-center gap-2 text-sm">
								<Chip tone="blue" dot={false}>
									{t(`browserAgent:recorder.kinds.${step.kind}`)}
								</Chip>
								<code className="min-w-0 truncate font-mono text-xs">{selectorSummary(step)}</code>
								<StepDetail step={step} />
								<StepNotes step={step} />
								<button
									type="button"
									className="wp-muted ml-auto rounded-md p-1 hover:text-foreground disabled:opacity-30"
									onClick={() => recorder.removeStep(step.id)}
									disabled={!idle}
									title={t("browserAgent:recorder.removeStep")}
									aria-label={t("browserAgent:recorder.removeStep")}
								>
									<X className="h-3.5 w-3.5" aria-hidden="true" />
								</button>
							</li>
						))}
					</ol>
				)}
			</Panel>

			<Panel>
				<h3 className="wp-kicker mb-2">{t("browserAgent:recorder.exportTitle")}</h3>
				<div className="space-y-3">
					<Input
						type="text"
						value={recorder.name}
						onChange={(e) => recorder.setName(e.target.value)}
						aria-label={t("browserAgent:recorder.nameLabel")}
						placeholder={t("browserAgent:recorder.namePlaceholder")}
						className="h-8 text-sm"
					/>
					<Tabs<TestFormat>
						label={t("browserAgent:recorder.formatLabel")}
						value={recorder.format}
						onChange={recorder.setFormat}
						tabs={TEST_FORMATS.map((id) => ({ id, label: t(`browserAgent:recorder.formats.${id}`) }))}
					/>
					<div className="flex flex-wrap gap-2">
						<CharterButton
							size="sm"
							icon={Eye}
							disabled={!canExport}
							busy={recorder.exporting === "preview"}
							onClick={() => exportTo("preview")}
						>
							{t("browserAgent:recorder.preview")}
						</CharterButton>
						<CharterButton
							size="sm"
							variant="primary"
							icon={GitPullRequest}
							disabled={!canExport}
							busy={recorder.exporting === "review"}
							onClick={() => exportTo("review")}
						>
							{t("browserAgent:recorder.review")}
						</CharterButton>
						<CharterButton
							size="sm"
							icon={FileDown}
							disabled={!canExport}
							busy={recorder.exporting === "file"}
							onClick={() => exportTo("file")}
						>
							{t("browserAgent:recorder.file")}
						</CharterButton>
					</div>
					<p className="wp-meta">{t("browserAgent:recorder.reviewHint")}</p>
				</div>
			</Panel>

			{outcome && (
				<div className="space-y-3" data-testid="recorder-outcome">
					{outcome.review && <GeneratedReviewBanner review={outcome.review} projectId={projectId} />}
					{outcome.path && !outcome.review && !outcome.cancelled && (
						<Notice tone="green">{t("browserAgent:recorder.savedTo", { path: outcome.path })}</Notice>
					)}
					{outcome.envVars && outcome.envVars.length > 0 && (
						<Notice tone="amber" icon={KeyRound}>
							{t("browserAgent:recorder.envVars", { names: outcome.envVars.join(", ") })}
						</Notice>
					)}
					{(outcome.skipped ?? 0) > 0 && (
						<Notice tone="amber" icon={AlertTriangle}>
							{t("browserAgent:recorder.skipped", { count: outcome.skipped })}
						</Notice>
					)}
					{outcome.code && (
						<pre className="max-h-96 overflow-auto rounded-md bg-[var(--wp-code-bg)] p-3 font-mono text-xs">
							{outcome.code}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
