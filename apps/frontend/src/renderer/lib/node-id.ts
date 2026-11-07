/**
 * Collision-free canvas node ids.
 *
 * The previous `(nodes.length + 1)` scheme reused ids after a delete (delete
 * "1", add, get "2" again), which left edges pointing at the wrong or a
 * now-missing node (the dangling `edge-1-6`). Module scope, so the callbacks
 * that mint ids stay referentially stable.
 */
export const genNodeId = (): string =>
	globalThis.crypto?.randomUUID?.() ??
	`n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
