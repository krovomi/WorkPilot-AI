import { useEffect } from "react";
import { create } from "zustand";
import type { ArchitectureDeltaStatus } from "../../main/architecture-visualizer-service";

/**
 * What a task changed in the architecture, per task.
 *
 * Keyed by task like `spec-traceability-store`, and for the same reason: the
 * detail modal can be closed and reopened on a different card while a request
 * is still out, and a late answer must not land on the card now showing.
 * The in-flight guard below is what makes that safe.
 */

interface Entry {
	status: ArchitectureDeltaStatus | null;
	loading: boolean;
	/** A regeneration is running for this task. */
	running: boolean;
	error: string | null;
	/** `file://` URL of delta.html, resolved only when there is one to show. */
	artifactUrl: string | null;
	/** The runner's own log lines, while a regeneration is running. */
	progress: string;
}

const EMPTY: Entry = {
	status: null,
	loading: false,
	running: false,
	error: null,
	artifactUrl: null,
	progress: "",
};

interface ArchitectureDeltaState {
	byTask: Record<string, Entry>;
	load: (args: { taskId: string; specDir: string }) => Promise<void>;
	regenerate: (args: {
		taskId: string;
		projectDir: string;
		specDir: string;
		changedFiles?: string[];
		taskSummary?: string;
	}) => Promise<void>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

/**
 * Which task's regeneration is running, if any.
 *
 * The service runs one process at a time and its events carry no task id, so
 * the id is remembered here at the moment the run starts rather than pushed
 * into the listener by every caller.
 */
let runningTaskId: string | null = null;

function patch(taskId: string, changes: Partial<Entry>): void {
	useArchitectureDeltaStore.setState((s) => ({
		byTask: {
			...s.byTask,
			[taskId]: { ...(s.byTask[taskId] ?? EMPTY), ...changes },
		},
	}));
}

export const useArchitectureDeltaStore = create<ArchitectureDeltaState>(
	(set) => ({
		byTask: {},

		load: async ({ taskId, specDir }) => {
			const controller = new AbortController();
			inFlight.get(taskId)?.abort();
			inFlight.set(taskId, controller);

			patch(taskId, { loading: true, error: null });
			const result = await window.electronAPI.readArchitectureDelta(specDir);

			// The modal moved on while this was out. Dropping the answer is the
			// point of the guard: it belongs to a card nobody is looking at.
			if (inFlight.get(taskId) !== controller) return;
			inFlight.delete(taskId);

			if (!result.success) {
				patch(taskId, { loading: false, error: result.error ?? "unknown error" });
				return;
			}

			const status = result.data ?? null;
			patch(taskId, { loading: false, status, error: null });

			// Only a mapped delta with something to show has an artifact worth
			// resolving; every other state renders text or nothing.
			if (status?.status === "mapped" && status.hasChanges && status.artifact) {
				const resolved = await window.electronAPI.resolveArchitectureArtifact(
					status.artifact,
				);
				patch(taskId, {
					artifactUrl: resolved.success ? (resolved.data?.url ?? null) : null,
				});
			} else {
				patch(taskId, { artifactUrl: null });
			}
		},

		regenerate: async ({
			taskId,
			projectDir,
			specDir,
			changedFiles,
			taskSummary,
		}) => {
			runningTaskId = taskId;
			patch(taskId, { running: true, error: null, progress: "" });
			// `force`: the user pressed the button, so the significance pre-pass
			// has already been overruled by a person.
			const result = await window.electronAPI.regenerateArchitectureDelta({
				projectDir,
				specDir,
				changedFiles,
				taskSummary,
				force: true,
			});
			if (!result.success) {
				runningTaskId = null;
				patch(taskId, {
					running: false,
					error: result.error ?? "could not start the comparison",
				});
			}
			// The run continues in the main process; `delta-status` ends it.
		},

		clear: (taskId) => {
			inFlight.get(taskId)?.abort();
			inFlight.delete(taskId);
			// A run started from this card keeps going in the main process; only
			// its record is dropped, so a late event has nowhere to land.
			if (runningTaskId === taskId) runningTaskId = null;
			set((s) => {
				const { [taskId]: _dropped, ...rest } = s.byTask;
				return { byTask: rest };
			});
		},
	}),
);

/**
 * Subscribe to delta events.
 *
 * One subscription for the whole app rather than one per card: the service
 * runs a single process at a time, so the running task is the one this store
 * recorded when the run started.
 */
export function setupArchitectureDeltaListeners(): () => void {
	const unsubStatus = window.electronAPI.onArchitectureDeltaStatus(
		async (status: ArchitectureDeltaStatus) => {
			const taskId = runningTaskId;
			if (!taskId) return;
			runningTaskId = null;
			patch(taskId, { running: false, status, error: null });

			if (status.status === "mapped" && status.hasChanges && status.artifact) {
				const resolved = await window.electronAPI.resolveArchitectureArtifact(
					status.artifact,
				);
				patch(taskId, {
					artifactUrl: resolved.success ? (resolved.data?.url ?? null) : null,
				});
			}
		},
	);

	const unsubChunk = window.electronAPI.onArchitectureVisualizerStreamChunk(
		(chunk: string) => {
			const taskId = runningTaskId;
			if (!taskId) return;
			useArchitectureDeltaStore.setState((s) => {
				const entry = s.byTask[taskId];
				if (!entry?.running) return s;
				return {
					byTask: {
						...s.byTask,
						[taskId]: { ...entry, progress: entry.progress + chunk },
					},
				};
			});
		},
	);

	const unsubError = window.electronAPI.onArchitectureVisualizerError(
		(error: string) => {
			const taskId = runningTaskId;
			if (!taskId) return;
			runningTaskId = null;
			useArchitectureDeltaStore.setState((s) => {
				const entry = s.byTask[taskId];
				if (!entry?.running) return s;
				return {
					byTask: { ...s.byTask, [taskId]: { ...entry, running: false, error } },
				};
			});
		},
	);

	return () => {
		unsubStatus();
		unsubChunk();
		unsubError();
	};
}

/**
 * Load a task's delta record and return it.
 *
 * Called by the task modal rather than by the tab, because the record is what
 * decides whether the tab exists at all: a component that loaded its own data
 * could never be the thing that answers "should this tab be shown".
 */
export function useArchitectureDelta(
	taskId: string,
	specDir: string | undefined,
): Entry | undefined {
	const load = useArchitectureDeltaStore((s) => s.load);
	const clear = useArchitectureDeltaStore((s) => s.clear);
	const entry = useArchitectureDeltaStore((s) => s.byTask[taskId]);

	useEffect(() => {
		if (!specDir) return;
		void load({ taskId, specDir });
		return () => clear(taskId);
	}, [taskId, specDir, load, clear]);

	return entry;
}

/**
 * Whether this task's delta is worth a tab.
 *
 * Two states render nothing and so get no tab: the change was not
 * architectural, and the comparison found no difference. A permanent tab that
 * reads "no change" on most tasks is a tab people stop opening — the same rule
 * `SpecTraceabilityCard` follows when it returns null on a clean spec.
 */
export function shouldShowArchitectureDelta(entry: Entry | undefined): boolean {
	if (!entry) return false;
	if (entry.running) return true;
	const status = entry.status;
	if (!status) return false;
	if (status.status === "not-significant") return false;
	if (status.status === "mapped") return status.hasChanges;
	return true;
}

export type { Entry as ArchitectureDeltaEntry };
