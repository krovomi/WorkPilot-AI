/**
 * The app switch of the approval tiers (`apps/backend/approvals`), the same
 * values as the backend's `WORKPILOT_APPROVALS`: `off` (nothing new),
 * `observe` (the tier is shown, nothing merges by itself, the default) and
 * `enforce` (a green PR of tier N0, or N1 with the cross-review's agreement,
 * merges by itself). A project's `workpilot.policy.yaml` can only restrict it.
 */

export const APPROVAL_TIER_MODES = ["off", "observe", "enforce"] as const;

export type ApprovalTierMode = (typeof APPROVAL_TIER_MODES)[number];

export const DEFAULT_APPROVAL_TIER_MODE: ApprovalTierMode = "observe";

/** Anything but a known mode is `observe`, never `enforce`. */
export function normalizeApprovalTierMode(value: unknown): ApprovalTierMode {
	return typeof value === "string" &&
		(APPROVAL_TIER_MODES as readonly string[]).includes(value)
		? (value as ApprovalTierMode)
		: DEFAULT_APPROVAL_TIER_MODE;
}
