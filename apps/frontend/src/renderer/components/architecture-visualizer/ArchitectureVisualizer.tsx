import { AlertTriangle, Loader2, Network, RefreshCw, X } from "lucide-react";
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
import { Button } from "../ui/button";

export function ArchitectureVisualizer(): React.ReactElement {
	const { t } = useTranslation(["architectureVisualizer"]);
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
		<div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)]">
			<header className="flex items-start justify-between gap-4 px-6 py-4 border-b border-[var(--border-color)]">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold">
						{t("architectureVisualizer:title")}
					</h1>
					<p className="text-sm text-[var(--text-secondary)] mt-0.5">
						{t("architectureVisualizer:subtitle")}
					</p>
					{baseline && (
						<p className="mt-1 text-xs text-[var(--text-secondary)]">
							{t("architectureVisualizer:model.components", {
								count: baseline.components ?? 0,
							})}
							{" • "}
							{t("architectureVisualizer:model.connections", {
								count: baseline.connections ?? 0,
							})}
							{baseline.revision && (
								<>
									{" • "}
									{t("architectureVisualizer:model.revision", {
										revision: baseline.revision.slice(0, 12),
									})}
								</>
							)}
						</p>
					)}
				</div>
				<div className="flex shrink-0 gap-2">
					{isRunning ? (
						<Button
							variant="outline"
							size="sm"
							onClick={cancelArchitectureVisualization}
						>
							<X className="mr-2 h-4 w-4" aria-hidden />
							{t("architectureVisualizer:actions.cancel")}
						</Button>
					) : (
						<Button
							size="sm"
							disabled={!canRun}
							onClick={() =>
								projectPath && generateArchitectureMap(projectPath)
							}
						>
							<RefreshCw className="mr-2 h-4 w-4" aria-hidden />
							{baseline
								? t("architectureVisualizer:actions.regenerate")
								: t("architectureVisualizer:actions.generate")}
						</Button>
					)}
				</div>
			</header>

			{blockers.length > 0 && (
				<section className="border-b border-amber-500/30 bg-amber-500/5 px-6 py-3">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
						<span className="text-sm font-medium">
							{t("architectureVisualizer:readiness.heading")}
						</span>
					</div>
					<p className="mt-1 text-xs text-[var(--text-secondary)]">
						{t("architectureVisualizer:readiness.body")}
					</p>
					<ul className="mt-2 space-y-1">
						{blockers.map((condition) => (
							<li key={condition.name} className="text-xs">
								<span className="font-medium">{condition.name}</span>
								{" — "}
								<span className="text-[var(--text-secondary)]">
									{condition.remedy || condition.detail}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}

			{error && (
				<section className="border-b border-red-500/30 bg-red-500/5 px-6 py-3">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-red-500" aria-hidden />
						<span className="text-sm font-medium">
							{t("architectureVisualizer:error.heading")}
						</span>
					</div>
					<p className="mt-1 text-xs text-[var(--text-secondary)]">{error}</p>
				</section>
			)}

			<div className="flex-1 min-h-0">
				{isRunning ? (
					<div className="flex h-full flex-col">
						<div className="flex items-center gap-2 border-b border-[var(--border-color)] px-6 py-2">
							<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
							<span className="text-sm">
								{status || t("architectureVisualizer:progress.checking")}
							</span>
						</div>
						<pre className="flex-1 overflow-auto whitespace-pre-wrap px-6 py-3 font-mono text-xs text-[var(--text-secondary)]">
							{streamingOutput}
						</pre>
					</div>
				) : artifactUrl ? (
					// The artifact is a self-contained 0.8-2.2 MB HTML document with
					// its own theming, pan/zoom and search. A webview keeps it out of
					// the renderer's document rather than inlining it.
					<webview
						key={artifactUrl}
						src={artifactUrl}
						className="h-full w-full border-0"
					/>
				) : (
					<div className="flex h-full items-center justify-center p-8">
						<div className="max-w-md text-center">
							<Network
								className="mx-auto h-10 w-10 text-[var(--text-secondary)]"
								aria-hidden
							/>
							<h2 className="mt-3 text-base font-medium">
								{t("architectureVisualizer:empty.title")}
							</h2>
							<p className="mt-2 text-sm text-[var(--text-secondary)]">
								{t("architectureVisualizer:empty.body")}
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
