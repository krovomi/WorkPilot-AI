/**
 * Browser mock for the memory's lifecycle (journal, trash, pins, conflicts).
 */

export const memoryLifecycleMock = {
	getMemoryLifecycle: async () => ({
		success: true as const,
		data: {
			journal: [],
			revertible: {},
			lastUndo: null,
			metrics: null,
			trash: [],
			conflicts: [],
			pinned: 0,
			pinLimit: 50,
			retentionDays: 30,
		},
	}),
	getMemoryHistory: async () => ({ success: true as const, data: [] }),
	forgetMemory: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
	restoreMemory: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
	pinMemory: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
	resolveMemoryConflict: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
	suggestMemoryResolution: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
	revertMemoryDecision: async () => ({
		success: false as const,
		error: "Not available in browser mock",
	}),
};
