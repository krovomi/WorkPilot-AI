/**
 * The body of `HOT_SWAP.json`, merged with a request still pending.
 *
 * The marker is single-shot: the running agent reads it at its next boundary.
 * Changing the model and then the effort of a phase sends two requests, often a
 * few seconds apart, and the second used to overwrite the first: on 2026-11-28
 * a card switched to Haiku 5.5 then to effort `none` kept only `model: null,
 * effort: none`, so the model change never reached the agent. A field the new
 * request leaves out now keeps the pending value of the same phase.
 */
export interface HotSwapChange {
	provider?: string;
	model?: string;
	effort?: string;
}

const FIELDS = ["provider", "model", "effort"] as const;

function pendingFields(
	pendingRaw: string | null,
	phase: string,
): Partial<Record<(typeof FIELDS)[number], string>> {
	if (!pendingRaw) return {};
	let pending: unknown;
	try {
		pending = JSON.parse(pendingRaw);
	} catch {
		return {};
	}
	if (!pending || typeof pending !== "object") return {};
	const record = pending as Record<string, unknown>;
	if (record.phase !== phase) return {};
	const kept: Partial<Record<(typeof FIELDS)[number], string>> = {};
	for (const field of FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value) kept[field] = value;
	}
	return kept;
}

export function hotSwapMarkerBody(
	phase: string,
	change: HotSwapChange,
	pendingRaw: string | null,
	now: Date = new Date(),
): string {
	const pending = pendingFields(pendingRaw, phase);
	return JSON.stringify({
		phase,
		provider: change.provider || pending.provider || null,
		model: change.model || pending.model || null,
		effort: change.effort || pending.effort || null,
		requested_at: now.toISOString(),
	});
}
