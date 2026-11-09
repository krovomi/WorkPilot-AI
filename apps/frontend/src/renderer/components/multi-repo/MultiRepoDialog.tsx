import type { MultiRepoOrchestration } from "@shared/types";
import { ArrowLeft, Play, Plus, Square } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMultiRepoStore } from "@/stores/multi-repo-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
	defaultEngineProvider,
	isUniformEngine,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { TaskEngineEditor } from "../task-engine/TaskEngineEditor";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { BreakingChangeBanner } from "./BreakingChangeBanner";
import { DependencyGraphView } from "./DependencyGraphView";
import { ExecutionMonitor } from "./ExecutionMonitor";
import { RepoSelector } from "./RepoSelector";

function titleOf(o: MultiRepoOrchestration): string {
	return o.taskDescription.split("\n").find((line) => line.trim())?.trim() ?? o.id;
}

/** Can be started again: never ran here, stopped, failed, or left by a closed app. */
function canStart(o: MultiRepoOrchestration): boolean {
	return !o.running && o.status !== "completed";
}

function OrchestrationList() {
	const { t } = useTranslation(["multiRepo"]);
	const orchestrations = useMultiRepoStore((s) => s.orchestrations);
	const showDetail = useMultiRepoStore((s) => s.showDetail);
	return (
		<ul className="space-y-2">
			{orchestrations.map((o) => (
				<li key={o.id}>
					<button
						type="button"
						onClick={() => showDetail(o.id)}
						className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/40"
					>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium text-foreground">{titleOf(o)}</div>
							<div className="truncate text-xs text-muted-foreground">
								{o.repos.map((r) => r.repo).join(" · ")}
							</div>
						</div>
						<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
							{t(`multiRepo:status.${o.status}`)}
						</span>
						<span className="w-10 shrink-0 text-right text-xs text-muted-foreground">
							{Math.round(o.overallProgress)}%
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/**
 * The engine of the repositories' tasks, seeded like a new board task: the
 * host project's provider, else the default provider in Settings.
 */
function EngineSection() {
	const { t } = useTranslation(["multiRepo"]);
	const engine = useMultiRepoStore((s) => s.engine);
	const setEngine = useMultiRepoStore((s) => s.setEngine);
	const projectId = useMultiRepoStore((s) => s.projectId);
	const projectProvider = useProjectStore(
		(s) => s.projects.find((p) => p.id === projectId)?.settings?.provider,
	);
	const { settings } = useSettingsStore(useShallow((s) => ({ settings: s.settings })));

	useEffect(() => {
		if (!engine) setEngine(seedEngine(settings, defaultEngineProvider(settings, projectProvider)));
	}, [engine, setEngine, settings, projectProvider]);

	if (!engine) return null;
	return (
		<section className="space-y-2">
			<h3 className="text-sm font-medium text-foreground">{t("multiRepo:dialog.stepEngine")}</h3>
			<TaskEngineEditor engine={engine} onChange={setEngine} idPrefix="multi-repo-engine" />
			<p className="text-xs text-muted-foreground">{t("multiRepo:dialog.engineHint")}</p>
		</section>
	);
}

function NewOrchestration() {
	const { t } = useTranslation(["multiRepo"]);
	const taskDescription = useMultiRepoStore((s) => s.taskDescription);
	const setTaskDescription = useMultiRepoStore((s) => s.setTaskDescription);
	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<h3 className="text-sm font-medium text-foreground">{t("multiRepo:dialog.stepRepos")}</h3>
				<RepoSelector />
			</section>
			<section className="space-y-2">
				<label htmlFor="multi-repo-task" className="text-sm font-medium text-foreground">
					{t("multiRepo:dialog.stepTask")}
				</label>
				<Textarea
					id="multi-repo-task"
					value={taskDescription}
					onChange={(e) => setTaskDescription(e.target.value)}
					placeholder={t("multiRepo:dialog.taskPlaceholder")}
					rows={5}
				/>
				<p className="text-xs text-muted-foreground">{t("multiRepo:dialog.howItRuns")}</p>
			</section>
			<EngineSection />
		</div>
	);
}

function EngineLine({ orchestration }: { readonly orchestration: MultiRepoOrchestration }) {
	const { t } = useTranslation(["multiRepo"]);
	const engine = orchestration.engine;
	const summary = engine
		? isUniformEngine(engine)
			? `${engine.coding.provider} · ${engine.coding.model} · ${engine.coding.effort}`
			: t("multiRepo:detail.engineMixed", { provider: engine.coding.provider, model: engine.coding.model })
		: t("multiRepo:detail.engineDefault");
	return (
		<p className="text-xs text-muted-foreground">
			{t("multiRepo:detail.engine")} <span className="text-foreground">{summary}</span>
		</p>
	);
}

function OrchestrationDetail({ orchestration }: { readonly orchestration: MultiRepoOrchestration }) {
	return (
		<div className="space-y-6">
			<p className="whitespace-pre-wrap text-sm text-foreground">{orchestration.taskDescription}</p>
			<EngineLine orchestration={orchestration} />
			<ExecutionMonitor orchestration={orchestration} />
			{orchestration.dependencyGraph.nodes.length > 0 && (
				<DependencyGraphView
					graph={orchestration.dependencyGraph}
					executionOrder={orchestration.executionOrder}
					repoStates={orchestration.repoStates}
				/>
			)}
			<BreakingChangeBanner breakingChanges={orchestration.breakingChanges} />
		</div>
	);
}

/**
 * MultiRepoDialog - one change across several repositories: the
 * orchestrations of the project, a form for a new one, and the follow-up of
 * a run (one Kanban card per repository, started in dependency order).
 */
export function MultiRepoDialog() {
	const { t } = useTranslation(["multiRepo", "common"]);
	const isOpen = useMultiRepoStore((s) => s.isDialogOpen);
	const view = useMultiRepoStore((s) => s.view);
	const orchestrations = useMultiRepoStore((s) => s.orchestrations);
	const activeId = useMultiRepoStore((s) => s.activeId);
	const pickedRepos = useMultiRepoStore((s) => s.pickedRepos);
	const taskDescription = useMultiRepoStore((s) => s.taskDescription);
	const busy = useMultiRepoStore((s) => s.busy);
	const error = useMultiRepoStore((s) => s.error);
	const { closeDialog, showList, showNew, launch, start, stop } = useMultiRepoStore.getState();

	const active = orchestrations.find((o) => o.id === activeId) ?? null;
	const canLaunch = pickedRepos.length >= 2 && taskDescription.trim().length > 0 && !busy;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && closeDialog()}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("multiRepo:dialog.title")}</DialogTitle>
					<DialogDescription>{t("multiRepo:dialog.description")}</DialogDescription>
				</DialogHeader>

				{view === "list" && <OrchestrationList />}
				{view === "new" && <NewOrchestration />}
				{view === "detail" && active && <OrchestrationDetail orchestration={active} />}

				{error && (
					<p role="alert" className="text-sm text-destructive">
						{t(`multiRepo:${error}`, { defaultValue: t("multiRepo:errors.createFailed") })}
					</p>
				)}

				<DialogFooter className="gap-2 sm:justify-between">
					<div>
						{view !== "list" && orchestrations.length > 0 && (
							<Button type="button" variant="ghost" onClick={showList}>
								<ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
								{t("multiRepo:dialog.back")}
							</Button>
						)}
					</div>
					<div className="flex gap-2">
						{view === "list" && (
							<Button type="button" onClick={showNew}>
								<Plus className="mr-2 h-4 w-4" aria-hidden="true" />
								{t("multiRepo:dialog.newOrchestration")}
							</Button>
						)}
						{view === "new" && (
							<Button type="button" onClick={() => void launch()} disabled={!canLaunch}>
								<Play className="mr-2 h-4 w-4" aria-hidden="true" />
								{busy ? t("multiRepo:dialog.creating") : t("multiRepo:dialog.launch")}
							</Button>
						)}
						{view === "detail" && active?.running && (
							<Button type="button" variant="outline" onClick={() => void stop(active.id)}>
								<Square className="mr-2 h-4 w-4" aria-hidden="true" />
								{t("multiRepo:dialog.stop")}
							</Button>
						)}
						{view === "detail" && active && canStart(active) && (
							<Button type="button" onClick={() => void start(active.id)}>
								<Play className="mr-2 h-4 w-4" aria-hidden="true" />
								{active.status === "pending"
									? t("multiRepo:dialog.start")
									: t("multiRepo:dialog.resume")}
							</Button>
						)}
						<Button type="button" variant="outline" onClick={closeDialog}>
							{t("common:buttons.close")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
