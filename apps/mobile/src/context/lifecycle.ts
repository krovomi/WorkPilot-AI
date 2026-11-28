/**
 * The lifecycle of a server project's memory (`shared_features/context_lifecycle.py`):
 * its trash, its pins and the decisions on one memory. A decision is the
 * team's, taken in the person's name (`insight.write`); the server answers
 * `success: false` with a code when it does not take one.
 */

/** A forgotten memory, still restorable until `restore_until`. */
export interface ForgottenMemory {
	id: string;
	kind: string;
	title: string;
	preview: string;
	forgotten_at: string;
	forgotten_by: string;
	reason: string;
	restore_until: string;
	expiring_soon: boolean;
}

export interface MemoryLifecycle {
	success: boolean;
	error?: string;
	trash?: ForgottenMemory[];
	pinned?: number;
	pin_limit?: number;
	retention_days?: number;
}

export interface MemoryDecision {
	success: boolean;
	error?: string;
	limit?: number;
}

/** A refused decision, as the screen says it. */
export class MemoryRefused extends Error {
	constructor(
		readonly code: string,
		readonly limit?: number,
	) {
		super(code);
	}
}

export function decided(answer: MemoryDecision): void {
	if (!answer.success) throw new MemoryRefused(answer.error ?? "failed", answer.limit);
}
