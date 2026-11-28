/**
 * What the phone says about a card's captures, as i18n keys and plain values:
 * pure functions, tested without a screen.
 */

import type { CaptureItem, CaptureSide, CardCaptures } from "./types";

/** A section is shown once the card has a publication. */
export function hasCaptures(captures: CardCaptures | null): captures is CardCaptures {
	return !!captures && (captures.needed || captures.items.length > 0);
}

/** The i18n key of where the captures stand with the pull request. */
export function stateKey(captures: CardCaptures): string {
	if (!captures.needed) return "captures.state_notNeeded";
	if (captures.publish === "never") return "captures.state_off";
	if (captures.publishable === 0) return "captures.state_noneToShow";
	if (captures.publish === "review" && !captures.approved) return "captures.state_waitingReview";
	const status = captures.sync?.status;
	if (status === "published") return "captures.state_inPr";
	if (status === "no-pr" || !captures.sync) return "captures.state_noPr";
	if (captures.sync.reason) return "captures.state_syncFailed";
	return "captures.state_ready";
}

/** The reason code of a failed sync, as a known key, else a generic one. */
export const SYNC_REASONS = [
	"no-credentials",
	"pr-unreadable",
	"pr-write-failed",
	"attachments-refused",
	"error",
] as const;

export function syncReasonKey(reason: string): string {
	return (SYNC_REASONS as readonly string[]).includes(reason)
		? `captures.reason_${reason.replace(/-/g, "_")}`
		: "captures.reason_other";
}

/** The i18n key of one side's privacy status. */
export function sideStatusKey(side: CaptureSide): string {
	const known = ["pseudonymized", "clean", "unchecked", "withheld", "failed"];
	return known.includes(side.status) ? `captures.status_${side.status}` : "captures.status_failed";
}

/** The screen's name: its label, else its route, else its platform. */
export function screenName(item: CaptureItem): string {
	if (item.label) return item.label;
	if (item.route) return `/${item.route.replace(/^\/+/, "")}`;
	return item.platform || "?";
}

/** The kinds of data replaced on both sides of a screen, once each. */
export function replacedKinds(item: CaptureItem): string[] {
	const kinds = new Set<string>();
	for (const side of [item.before, item.after]) for (const kind of side?.kinds ?? []) kinds.add(kind);
	return [...kinds].sort();
}

/** Publish and Withdraw are a review's answer: only in review mode, with something to publish. */
export function canAnswerReview(captures: CardCaptures): boolean {
	return captures.needed && captures.publish === "review" && captures.publishable > 0;
}
