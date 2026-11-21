/**
 * The memory's lifecycle in the Memories tab: journal, trash, pins and the
 * sync conflicts waiting for a person (`main/ipc-handlers/context/memory-lifecycle-handlers.ts`).
 *
 * The renderer names a project by id and a memory by its vault path; the
 * main process revalidates both.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	IPCResult,
	MemoryConflictChoice,
	MemoryConflictOpinion,
	MemoryJournalEntry,
	MemoryLifecycleView,
	MemoryRestoreOutcome,
	MemoryRevertOutcome,
} from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface MemoryLifecycleAPI {
	getMemoryLifecycle: (
		projectId: string,
	) => Promise<IPCResult<MemoryLifecycleView>>;
	getMemoryHistory: (
		projectId: string,
		memoryId: string,
	) => Promise<IPCResult<MemoryJournalEntry[]>>;
	forgetMemory: (
		projectId: string,
		memoryId: string,
		reason?: string,
	) => Promise<IPCResult<void>>;
	restoreMemory: (
		projectId: string,
		trashId: string,
	) => Promise<IPCResult<MemoryRestoreOutcome>>;
	pinMemory: (
		projectId: string,
		memoryId: string,
		pinned: boolean,
	) => Promise<IPCResult<{ count: number }>>;
	resolveMemoryConflict: (
		projectId: string,
		conflictId: string,
		choice: MemoryConflictChoice,
		text?: string,
	) => Promise<IPCResult<{ canonical: string | null }>>;
	suggestMemoryResolution: (
		projectId: string,
		conflictId: string,
	) => Promise<IPCResult<MemoryConflictOpinion>>;
	/** Where a memory applies (a part of the code); empty: everywhere. */
	setMemoryScope: (
		projectId: string,
		memoryId: string,
		appliesTo: string,
	) => Promise<IPCResult<{ appliesTo: string }>>;
	/** Who settles a conflict that flip-flops; an empty list: anyone. */
	setMemoryMaintainers: (
		projectId: string,
		names: string[],
	) => Promise<IPCResult<string[]>>;
	/** Undo an automatic decision of the last hour, or separate a merge. */
	revertMemoryDecision: (
		projectId: string,
		entryId: string,
	) => Promise<IPCResult<MemoryRevertOutcome>>;
}

export function createMemoryLifecycleAPI(): MemoryLifecycleAPI {
	return {
		getMemoryLifecycle: (projectId) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, projectId),
		getMemoryHistory: (projectId, memoryId) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, projectId, memoryId),
		forgetMemory: (projectId, memoryId, reason = "") =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_FORGET, projectId, memoryId, reason),
		restoreMemory: (projectId, trashId) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, projectId, trashId),
		pinMemory: (projectId, memoryId, pinned) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_PIN, projectId, memoryId, pinned),
		resolveMemoryConflict: (projectId, conflictId, choice, text = "") =>
			invokeIpc(
				IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT,
				projectId,
				conflictId,
				choice,
				text,
			),
		suggestMemoryResolution: (projectId, conflictId) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, projectId, conflictId),
		setMemoryScope: (projectId, memoryId, appliesTo) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_SET_SCOPE, projectId, memoryId, appliesTo),
		setMemoryMaintainers: (projectId, names) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_SET_MAINTAINERS, projectId, names),
		revertMemoryDecision: (projectId, entryId) =>
			invokeIpc(IPC_CHANNELS.CONTEXT_MEMORY_REVERT, projectId, entryId),
	};
}
