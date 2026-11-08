import { AlertTriangle, Copy, Layers, Play, Square, Workflow } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
	CI_PLATFORMS,
	type CiPlatform,
	cancelPipelineGeneration,
	generatePipelines,
	PLATFORM_LABELS,
	usePipelineGeneratorStore,
} from "../../stores/pipeline-generator-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
	Tabs,
	type Tone,
} from "../charter";
import { ProjectSelector } from "../settings/ProjectSelector";

/** CI/CD pipelines written for the project's own stacks, on the chosen platforms. */
export function PipelineGenerator(): React.ReactElement {
	const { t } = useTranslation(["pipelineGenerator", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const activeProjectId = useProjectStore((s) => s.activeProjectId);
	const setActiveProject = useProjectStore((s) => s.setActiveProject);
	const {
		phase,
		status,
		streamingOutput,
		result,
		error,
		selectedPlatforms,
		selectedPlatformView,
		togglePlatform,
		setSelectedPlatformView,
	} = usePipelineGeneratorStore();

	const isRunning = phase === "generating";
	const isComplete = phase === "complete";
	const view = selectedPlatformView ?? result?.platforms_generated?.[0] ?? null;
	const pipeline = isComplete && result && view ? result.pipelines[view] : null;
	const savedTo = result && view ? result.saved_files?.[view] : undefined;
	const stack = isComplete ? result?.stack : undefined;

	return (
		<ModuleStage data-testid="pipeline-generator-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("pipelineGenerator:title")}
				description={t("pipelineGenerator:description")}
				icon={Layers}
				tone="blue"
				actions={
					isRunning ? (
						<CharterButton variant="danger" icon={Square} onClick={cancelPipelineGeneration}>
							{t("pipelineGenerator:actions.cancel")}
						</CharterButton>
					) : (
						<CharterButton
							variant="primary"
							icon={Play}
							onClick={() => activeProject?.path && generatePipelines(activeProject.path)}
							disabled={!activeProject || selectedPlatforms.length === 0}
						>
							{isComplete
								? t("pipelineGenerator:actions.regenerate")
								: t("pipelineGenerator:actions.generate")}
						</CharterButton>
					)
				}
			/>

			<Columns template="minmax(0, 1fr) minmax(0, 2.4fr)">
				<Column kicker={t("pipelineGenerator:kickers.setup")} title={t("pipelineGenerator:platforms")} tone="blue">
					<Panel className="space-y-4">
						<div className="space-y-1.5">
							<span className="wp-kicker block">{t("pipelineGenerator:project")}</span>
							<ProjectSelector
								selectedProjectId={activeProjectId}
								onProjectChange={(id) => {
									if (id) setActiveProject(id);
								}}
							/>
						</div>
						<div className="space-y-1.5">
							<span className="wp-kicker block">{t("pipelineGenerator:platforms")}</span>
							<div className="wp-chips">
								{CI_PLATFORMS.map((platform) => (
									<Chip
										key={platform}
										tone="blue"
										pressed={selectedPlatforms.includes(platform)}
										onClick={isRunning ? undefined : () => togglePlatform(platform)}
									>
										{PLATFORM_LABELS[platform]}
									</Chip>
								))}
							</div>
						</div>
					</Panel>
					{stack && (
						<Panel className="mt-3 space-y-2.5">
							<span className="wp-kicker block">{t("pipelineGenerator:detectedStack")}</span>
							<StackChips label={t("pipelineGenerator:stackInfo.languages")} values={stack.languages} tone="violet" />
							<StackChips label={t("pipelineGenerator:stackInfo.frameworks")} values={stack.frameworks} tone="blue" />
							<StackChips label={t("pipelineGenerator:stackInfo.testRunners")} values={stack.test_runners} tone="green" />
							{stack.has_docker && <Chip tone="blue">{t("pipelineGenerator:stackInfo.dockerDetected")}</Chip>}
						</Panel>
					)}
				</Column>

				<Column
					kicker={t("pipelineGenerator:kickers.pipeline")}
					title={view && isComplete ? PLATFORM_LABELS[view] : t("pipelineGenerator:viewPipeline")}
					meta={pipeline ? t("pipelineGenerator:lineCount", { count: pipeline.split("\n").length }) : undefined}
					actions={
						pipeline ? (
							<CharterButton
								size="sm"
								variant="ghost"
								icon={Copy}
								onClick={() => navigator.clipboard.writeText(pipeline).catch(console.error)}
							>
								{t("pipelineGenerator:actions.copy")}
							</CharterButton>
						) : undefined
					}
				>
					<div className="space-y-3">
						{!activeProject && (
							<Notice tone="amber" icon={AlertTriangle}>
								{t("pipelineGenerator:errors.noProject")}
							</Notice>
						)}
						{isRunning && <ScanLine label={status || t("pipelineGenerator:status.generating")} />}
						{error && (
							<Notice tone="red" icon={AlertTriangle} role="alert">
								{error}
							</Notice>
						)}
						{isComplete && result && result.platforms_generated.length > 1 && (
							<Tabs<CiPlatform>
								label={t("pipelineGenerator:viewPipeline")}
								tabs={result.platforms_generated.map((p) => ({ id: p, label: PLATFORM_LABELS[p] }))}
								value={view ?? result.platforms_generated[0]}
								onChange={setSelectedPlatformView}
							/>
						)}
						{pipeline ? (
							<>
								<pre className="wp-code overflow-auto text-xs">{pipeline}</pre>
								{savedTo && (
									<p className="wp-meta">
										{t("pipelineGenerator:savedTo")} <span className="font-mono">{savedTo}</span>
									</p>
								)}
							</>
						) : streamingOutput && !isComplete ? (
							<pre className="wp-code overflow-auto whitespace-pre-wrap text-xs">{streamingOutput}</pre>
						) : (
							!isRunning &&
							!error && (
								<EmptyStage icon={Workflow} tone="blue" title={t("pipelineGenerator:emptyState.title")}>
									{t("pipelineGenerator:emptyState.description")}
								</EmptyStage>
							)
						)}
					</div>
				</Column>
			</Columns>
		</ModuleStage>
	);
}

function StackChips({
	label,
	values,
	tone,
}: {
	readonly label: string;
	readonly values: readonly string[];
	readonly tone: Tone;
}): React.ReactElement | null {
	if (values.length === 0) return null;
	return (
		<div>
			<span className="wp-meta">{label}</span>
			<div className="wp-chips mt-1">
				{values.map((v) => (
					<Chip key={v} tone={tone} dot={false}>
						{v}
					</Chip>
				))}
			</div>
		</div>
	);
}

export default PipelineGenerator;
