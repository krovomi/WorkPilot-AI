import { AlertTriangle, Network, RefreshCw, X } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
	cancelArchitectureVisualization,
	generateArchitectureMap,
	loadArchitectureState,
	useArchitectureVisualizerStore,
} from "../../stores/architecture-visualizer-store";
import { useProjectStore } from "../../stores/project-store";
import {
	CharterButton,
	Chip,
	Chips,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	ScanLine,
} from "../charter";

export function ArchitectureVisualizer(): React.ReactElement {
	const { t } = useTranslation(["architectureVisualizer", "navigation"]);
	const activeProject = useProjectStore((s) => s.getActiveProject());
	const projectPath = activeProject?.path;

	const phase = useArchitectureVisualizerStore((s) => s.phase);
	const status = useArchitectureVisualizerStore((s) => s.status);
	const streamingOutput = useArchitectureVisualizerStore(
		(s) => s.streamingOutput,
	);
	const readiness = useArchitectureVisualizerStore((s) => s.readiness);
	const baseline = useArchitectureVisualizerStore((s) => s.baseline);
	const artifactUrl = useArchitectureVisualizerStore((s) => s.artifactUrl);
	const error = useArchitectureVisualizerStore((s) => s.error);

	// The listeners existed and were installed by nobody, so every generation
	// ended on a spinner that never resolved. Mounting is what subscribes.

	// Read what is already on disk, so reopening the page shows the map rather
	// than an empty state that invites a second, identical generation.
	useEffect(() => {
		if (projectPath) void loadArchitectureState(projectPath);
	}, [projectPath]);

	const isRunning = phase === "generating";
	const blockers = readiness?.conditions.filter((c) => c.blocking && !c.ok) ?? [];
	const canRun = Boolean(projectPath) && blockers.length === 0;

	return (
		<ModuleStage data-testid="architecture-visualizer-view">
			<ModuleHeader
				kicker={t("navigation:groups.explore")}
				icon={Network}
				title={t("architectureVisualizer:title")}
				description={t("architectureVisualizer:subtitle")}
				tone="blue"
				actions={
					baseline && (
						<Chips>
							<Chip tone="blue">
								{t("architectureVisualizer:model.components", { count: baseline.components ?? 0 })}
							</Chip>
							<Chip tone="violet">
								{t("architectureVisualizer:model.connections", { count: baseline.connections ?? 0 })}
							</Chip>
							{baseline.revision && (
								<Chip tone="muted" dot={false}>
									{t("architectureVisualizer:model.revision", { revision: baseline.revision.slice(0, 12) })}
								</Chip>
							)}
						</Chips>
					)
				}
			/>

			{blockers.length > 0 && (
				<Notice tone="amber" icon={AlertTriangle} className="relative z-[2] mx-5 mb-3">
					<span className="font-medium">{t("architectureVisualizer:readiness.heading")}</span>
					<span className="mt-1 block text-xs">{t("architectureVisualizer:readiness.body")}</span>
					<ul className="mt-2 space-y-1">
						{blockers.map((condition) => (
							<li key={condition.name} className="text-xs">
								<span className="font-medium">{condition.name}</span>
								{" — "}
								<span className="wp-muted">{condition.remedy || condition.detail}</span>
							</li>
						))}
					</ul>
				</Notice>
			)}

			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="relative z-[2] mx-5 mb-3">
					<span className="font-medium">{t("architectureVisualizer:error.heading")}</span>
					<span className="mt-1 block text-xs">{error}</span>
				</Notice>
			)}

			<div className="relative z-[1] mx-5 mb-3 min-h-0 flex-1 overflow-hidden">
				{isRunning ? (
					<Panel className="flex h-full flex-col gap-2">
						<ScanLine label={status || t("architectureVisualizer:progress.checking")} />
						<pre className="wp-code min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">
							{streamingOutput}
						</pre>
					</Panel>
				) : artifactUrl ? (
					// The artifact is a self-contained 0.8-2.2 MB HTML document with
					// its own theming, pan/zoom and search. A webview keeps it out of
					// the renderer's document rather than inlining it.
					<div className="wp-card h-full overflow-hidden">
						<webview key={artifactUrl} src={artifactUrl} className="h-full w-full border-0" />
					</div>
				) : (
					<div className="flex h-full items-center justify-center">
						<EmptyStage icon={Network} title={t("architectureVisualizer:empty.title")} tone="blue">
							{t("architectureVisualizer:empty.body")}
						</EmptyStage>
					</div>
				)}
			</div>

			<Composer
				prompt={
					<span className="wp-muted flex min-w-0 items-center gap-2 text-xs">
						<Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="truncate">{t("architectureVisualizer:subtitle")}</span>
					</span>
				}
				actions={
					isRunning ? (
						<CharterButton variant="danger" icon={X} onClick={cancelArchitectureVisualization}>
							{t("architectureVisualizer:actions.cancel")}
						</CharterButton>
					) : (
						<CharterButton
							variant="primary"
							icon={RefreshCw}
							disabled={!canRun}
							onClick={() => projectPath && generateArchitectureMap(projectPath)}
						>
							{baseline
								? t("architectureVisualizer:actions.regenerate")
								: t("architectureVisualizer:actions.generate")}
						</CharterButton>
					)
				}
			/>
		</ModuleStage>
	);
}
