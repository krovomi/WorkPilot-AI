import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import { isSubtaskDone } from "../../../shared/progress";
import type { Project, Task } from "../../../shared/types";
import {
	type InterruptedPhase,
	type InterruptedResumeResult,
	type InterruptedTask,
	type InterruptedTasksOffer,
	type InterruptionOrigin,
	normalizeInterruptedLaunchPolicy,
} from "../../../shared/types/interrupted-tasks";
import type { EnginePhase } from "../../../shared/utils/task-engine";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { getClaudeProfileManager } from "../../claude-profile-manager";
import { projectStore } from "../../project-store";
import { readSettingsFile } from "../../settings-utils";
import { safeSendToRenderer } from "../utils";
import {
	APP_SHUTDOWN_PAUSE_REASON,
	markPauseDeferred,
	type PauseStateRecord,
	writePauseState,
} from "./pause-state-utils";
import { interruptionOrigin } from "./interrupted-origin";
import { allSpecDirs, currentPausePhase, getSpecPaths, resumePausedTask } from "./resume-task";

/**
 * The builds a launch found interrupted, offered to the person instead of
 * restarted behind their back.
 *
 * `interrupted-runs.ts` records, when WorkPilot closes, which builds were
 * running (`reason: "app_shutdown"`). This module decides what the next launch
 * does with them, from Settings › Agents (`interruptedTasksOnLaunch`):
 *
 * - `ask` (default): the renderer shows the list (InterruptedTasksDialog) and
 *   the person ticks what to resume. « Plus tard » marks the rest deferred, so
 *   the next launch does not ask about them again; each keeps its Reprendre.
 * - `always`: what the app did before — every build the app interrupted is
 *   resumed, except one a check says would fail at once.
 * - `never`: nothing starts; each card keeps its pause and its Reprendre.
 *
 * Three ways a build can have stopped, and each is listed: a clean close (the
 * shutdown pause), a crash or forced kill (a task still persisted as running
 * with no process — settled here into the same pause, `crashed: true`, so its
 * card stops reading "stuck" and the stuck recovery never resets its subtask),
 * and « Arrêter tous les agents » or « stop » to the voice assistant, which the
 * person asked for: offered once, unticked, never resumed by `always`.
 *
 * Every resume goes through `resumePausedTask`, the Reprendre button's path:
 * the backend re-enters the phase from the spec directory and reopens the
 * subtask the dead process was on. The project's « En cours » limit is kept:
 * past it, a build waits here and starts when a slot frees up.
 */

/** The Kanban's own default for « En cours » (KanbanBoard). */
const DEFAULT_MAX_PARALLEL = 3;

/** A renderer answer longer than this is not an answer to the dialog. */
const MAX_IDS = 200;

/** What the dialog offered this launch; the only ids a resolve may name. */
let offered: InterruptedTask[] = [];

/** Selected builds waiting for a free « En cours » slot, by project. */
const waitingForSlot = new Map<string, string[]>();
let slotWatchInstalled = false;

function phaseOf(task: Task, project: Project): InterruptedPhase {
	const recorded = task.metadata?.paused?.paused_phase;
	if (
		recorded === "spec" ||
		recorded === "planning" ||
		recorded === "coding" ||
		recorded === "qa_review" ||
		recorded === "qa_fixing"
	) {
		return recorded;
	}
	return currentPausePhase(task, getSpecPaths(task, project)) as InterruptedPhase;
}

function enginePhase(phase: InterruptedPhase): EnginePhase {
	return phase === "qa_review" || phase === "qa_fixing" ? "qa" : phase;
}

function claudeSignedIn(): boolean {
	try {
		return getClaudeProfileManager().hasValidAuth();
	} catch {
		return true; // not initialised: the build's own check answers later
	}
}

function describe(
	task: Task,
	project: Project,
	origin: InterruptionOrigin,
	agentManager: AgentManager,
): InterruptedTask {
	const phase = phaseOf(task, project);
	const subtasks = task.subtasks ?? [];
	const next = subtasks.find((s) => !isSubtaskDone(s.status));
	let blocker: InterruptedTask["blocker"] = null;
	if (allSpecDirs(getSpecPaths(task, project)).length === 0) {
		blocker = "spec_missing";
	} else if (
		agentManager.taskNeedsClaudeAuth(project.path, task.specId, enginePhase(phase)) &&
		!claudeSignedIn()
	) {
		blocker = "claude_auth";
	}
	const paused = task.metadata?.paused;
	const updated = task.updatedAt ? new Date(task.updatedAt) : null;
	return {
		taskId: task.id,
		projectId: project.id,
		projectName: project.name,
		title: task.title,
		origin,
		interruptedAt:
			(paused?.enabled ? paused.paused_at : null) ??
			(updated && !Number.isNaN(updated.getTime()) ? updated.toISOString() : null),
		phase,
		subtasksDone: subtasks.filter((s) => isSubtaskDone(s.status)).length,
		subtasksTotal: subtasks.length,
		nextSubtask: phase === "coding" ? next?.title || next?.description || null : null,
		provider: paused?.provider ?? task.metadata?.provider ?? null,
		model: paused?.model ?? task.metadata?.model ?? null,
		blocker,
		selectedByDefault: origin !== "stopped_by_you" && blocker === null,
	};
}

/**
 * A crashed build has no pause behind it, only a running status: record the
 * shutdown pause it never got, so it reads paused (Reprendre), not stuck.
 */
function settleCrash(task: Task, project: Project): void {
	const specPaths = getSpecPaths(task, project);
	const state: PauseStateRecord = {
		enabled: true,
		paused_at: new Date().toISOString(),
		paused_phase: currentPausePhase(task, specPaths),
		paused_subtask_id: task.executionProgress?.currentSubtask ?? null,
		provider: task.metadata?.provider ?? null,
		model: task.metadata?.model ?? null,
		reason: APP_SHUTDOWN_PAUSE_REASON,
		crashed: true,
	};
	writePauseState(allSpecDirs(specPaths), state);
}

/**
 * Every interrupted build, newest interruption first: of every project at
 * launch, of one project when the board asks (its builds put off included).
 */
export function collectInterruptedTasks(
	agentManager: AgentManager,
	options: { readonly projectId?: string; readonly includeDeferred?: boolean } = {},
): InterruptedTask[] {
	const found: InterruptedTask[] = [];
	const isRunning = (id: string) => agentManager.isRunning(id);
	const projects = projectStore
		.getProjects()
		.filter((p) => options.projectId === undefined || p.id === options.projectId);
	for (const project of projects) {
		let tasks: Task[];
		try {
			projectStore.invalidateTasksCache(project.id);
			tasks = projectStore.getTasks(project.id);
		} catch (err) {
			appLog.warn(`[interrupted-prompt] Could not read tasks of ${project.id}:`, err);
			continue;
		}
		for (const task of tasks) {
			const origin = interruptionOrigin(task, isRunning, options);
			if (!origin) continue;
			try {
				if (origin === "crash" && !task.metadata?.paused?.enabled) settleCrash(task, project);
				found.push(describe(task, project, origin, agentManager));
			} catch (err) {
				appLog.warn(`[interrupted-prompt] Could not read ${task.id}:`, err);
			}
		}
	}
	return found.sort((a, b) => (b.interruptedAt ?? "").localeCompare(a.interruptedAt ?? ""));
}

function inProgressRunning(projectId: string, agentManager: AgentManager): number {
	try {
		return projectStore
			.getTasks(projectId)
			.filter((t) => t.status === "in_progress" && agentManager.isRunning(t.id)).length;
	} catch {
		return 0;
	}
}

function slotLimit(projectId: string): number {
	const project = projectStore.getProjects().find((p) => p.id === projectId);
	const limit = project?.settings?.maxParallelTasks;
	return typeof limit === "number" && limit > 0 ? limit : DEFAULT_MAX_PARALLEL;
}

async function resumeOne(
	agentManager: AgentManager,
	item: InterruptedTask,
	result: InterruptedResumeResult,
): Promise<void> {
	try {
		const outcome = await resumePausedTask(agentManager, item.taskId, item.projectId);
		if (outcome.success) result.resumed.push(item.taskId);
		else result.failed.push({ taskId: item.taskId, error: outcome.error ?? "" });
	} catch (err) {
		result.failed.push({ taskId: item.taskId, error: String(err) });
	}
}

/** When a build of a project ends, the next one waiting for its slot starts. */
function watchSlots(agentManager: AgentManager): void {
	if (slotWatchInstalled) return;
	slotWatchInstalled = true;
	agentManager.on("exit", (_taskId: string, _code: number | null, _type: unknown, projectId?: string) => {
		const projects = projectId ? [projectId] : [...waitingForSlot.keys()];
		for (const id of projects) void drainSlots(agentManager, id);
	});
}

async function drainSlots(agentManager: AgentManager, projectId: string): Promise<void> {
	const queue = waitingForSlot.get(projectId);
	if (!queue?.length) return;
	while (queue.length > 0 && inProgressRunning(projectId, agentManager) < slotLimit(projectId)) {
		const taskId = queue.shift() as string;
		const result: InterruptedResumeResult = { resumed: [], waiting: [], failed: [] };
		await resumeOne(agentManager, { taskId, projectId } as InterruptedTask, result);
		for (const failure of result.failed) {
			appLog.warn(`[interrupted-prompt] ${failure.taskId} not resumed: ${failure.error}`);
		}
	}
	if (queue.length === 0) waitingForSlot.delete(projectId);
}

/**
 * Resume these builds, within each project's « En cours » limit. A build in
 * `in_progress` past the limit waits for a slot; one in AI review (QA) does
 * not take one, as on the board.
 */
export async function resumeInterrupted(
	agentManager: AgentManager,
	items: InterruptedTask[],
): Promise<InterruptedResumeResult> {
	const result: InterruptedResumeResult = { resumed: [], waiting: [], failed: [] };
	const used = new Map<string, number>();
	for (const item of items) {
		const task = projectStore.getTasks(item.projectId).find((t) => t.id === item.taskId);
		if (task?.status === "in_progress") {
			const running = used.get(item.projectId) ?? inProgressRunning(item.projectId, agentManager);
			if (running >= slotLimit(item.projectId)) {
				const queue = waitingForSlot.get(item.projectId) ?? [];
				queue.push(item.taskId);
				waitingForSlot.set(item.projectId, queue);
				result.waiting.push(item.taskId);
				continue;
			}
			used.set(item.projectId, running + 1);
		}
		await resumeOne(agentManager, item, result);
	}
	if (result.waiting.length > 0) watchSlots(agentManager);
	appLog.info(
		`[interrupted-prompt] resumed ${result.resumed.length}, waiting ${result.waiting.length}, failed ${result.failed.length}`,
	);
	return result;
}

/** « Plus tard »: each keeps its pause and its Reprendre, and is not offered again. */
export function deferInterrupted(items: InterruptedTask[]): void {
	const at = new Date().toISOString();
	for (const item of items) {
		const project = projectStore.getProjects().find((p) => p.id === item.projectId);
		const task = project
			? projectStore.getTasks(project.id).find((t) => t.id === item.taskId)
			: undefined;
		if (!project || !task) continue;
		markPauseDeferred(allSpecDirs(getSpecPaths(task, project)), at);
		projectStore.invalidateTasksCache(project.id);
	}
}

/**
 * At launch, once the window has loaded: apply Settings › Agents to the
 * builds the last exit interrupted. Returns what was offered or resumed.
 */
export async function offerInterruptedTasksAtLaunch(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): Promise<InterruptedTasksOffer | null> {
	const policy = normalizeInterruptedLaunchPolicy(readSettingsFile()?.interruptedTasksOnLaunch);
	const tasks = collectInterruptedTasks(agentManager);
	if (tasks.length === 0) return null;
	appLog.info(`[interrupted-prompt] ${tasks.length} interrupted task(s) found, policy ${policy}`);
	if (policy === "never") return null;
	if (policy === "always") {
		const chosen = tasks.filter((t) => t.selectedByDefault);
		if (chosen.length === 0) return null;
		const result = await resumeInterrupted(agentManager, chosen);
		const offer: InterruptedTasksOffer = {
			mode: "resumed",
			tasks: chosen,
			resumed: [...result.resumed, ...result.waiting],
		};
		safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_INTERRUPTED_OFFER, offer);
		return offer;
	}
	offered = tasks;
	const offer: InterruptedTasksOffer = { mode: "ask", tasks };
	safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_INTERRUPTED_OFFER, offer);
	return offer;
}

/** The renderer's answer, revalidated: only ids this launch offered count. */
export function parseResumeIds(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_IDS) return null;
	if (!raw.every((id) => typeof id === "string" && id.length > 0 && id.length < 300)) return null;
	return raw as string[];
}

export function registerInterruptedTaskHandlers(agentManager: AgentManager): void {
	// A reloaded renderer asks again: the offer stands until it is answered.
	ipcMain.handle(IPC_CHANNELS.TASK_INTERRUPTED_GET, (): InterruptedTasksOffer | null =>
		offered.length > 0 ? { mode: "ask", tasks: offered } : null,
	);
	// The board's « N tâches interrompues » chip: this project's builds, put
	// off ones included, offered again (and answered through RESOLVE).
	ipcMain.handle(
		IPC_CHANNELS.TASK_INTERRUPTED_LIST,
		(_event, rawProjectId: unknown): InterruptedTask[] => {
			if (typeof rawProjectId !== "string" || rawProjectId.length === 0) return [];
			if (!projectStore.getProjects().some((p) => p.id === rawProjectId)) return [];
			offered = collectInterruptedTasks(agentManager, {
				projectId: rawProjectId,
				includeDeferred: true,
			});
			return offered;
		},
	);
	ipcMain.handle(
		IPC_CHANNELS.TASK_INTERRUPTED_RESOLVE,
		async (_event, rawIds: unknown): Promise<InterruptedResumeResult> => {
			const ids = parseResumeIds(rawIds);
			if (!ids) return { resumed: [], waiting: [], failed: [] };
			const wanted = new Set(ids);
			const chosen = offered.filter((t) => wanted.has(t.taskId));
			const rest = offered.filter((t) => !wanted.has(t.taskId));
			offered = [];
			deferInterrupted(rest);
			return resumeInterrupted(agentManager, chosen);
		},
	);
}

/** Test seam: forget what this launch offered and who waits for a slot. */
export function resetInterruptedPromptForTests(): void {
	offered = [];
	waitingForSlot.clear();
	slotWatchInstalled = false;
}
