/**
 * The memory-lifecycle bridge forwards a project id and a memory, trash,
 * conflict or journal id on its own channel, as data (main revalidates them).
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMemoryLifecycleAPI } from "../memory-lifecycle-api";

const MEMORY = "knowledge/projects/shop/memory/gotchas/x.md";

describe("createMemoryLifecycleAPI", () => {
	it("invokes one channel per call, with its arguments and their defaults", async () => {
		const api = createMemoryLifecycleAPI();
		const calls: Array<[() => Promise<unknown>, unknown[]]> = [
			[() => api.getMemoryLifecycle("p1"), [IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1"]],
			[() => api.getMemoryHistory("p1", MEMORY), [IPC_CHANNELS.CONTEXT_MEMORY_HISTORY, "p1", MEMORY]],
			[() => api.forgetMemory("p1", MEMORY), [IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "p1", MEMORY, ""]],
			[() => api.forgetMemory("p1", MEMORY, "old"), [IPC_CHANNELS.CONTEXT_MEMORY_FORGET, "p1", MEMORY, "old"]],
			[() => api.restoreMemory("p1", "gotchas/x.md"), [IPC_CHANNELS.CONTEXT_MEMORY_RESTORE, "p1", "gotchas/x.md"]],
			[() => api.pinMemory("p1", MEMORY, true), [IPC_CHANNELS.CONTEXT_MEMORY_PIN, "p1", MEMORY, true]],
			[() => api.resolveMemoryConflict("p1", "0123456789abcdef", "a"),
				[IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", "0123456789abcdef", "a", ""],
			],
			[() => api.resolveMemoryConflict("p1", "0123456789abcdef", "custom", "x"),
				[IPC_CHANNELS.CONTEXT_MEMORY_RESOLVE_CONFLICT, "p1", "0123456789abcdef", "custom", "x"],
			],
			[() => api.suggestMemoryResolution("p1", "0123456789abcdef"),
				[IPC_CHANNELS.CONTEXT_MEMORY_SUGGEST_RESOLUTION, "p1", "0123456789abcdef"],
			],
			[() => api.revertMemoryDecision("p1", "0123456789ab"),
				[IPC_CHANNELS.CONTEXT_MEMORY_REVERT, "p1", "0123456789ab"],
			],
		];
		for (const [call, expected] of calls) {
			await call();
			expect(invokeIpc).toHaveBeenLastCalledWith(...expected);
		}
	});
});
