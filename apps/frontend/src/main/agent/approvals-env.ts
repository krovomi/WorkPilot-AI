/**
 * The approval tier switch (Settings, Approval tiers) as the variable the
 * backend reads: `WORKPILOT_APPROVALS` (`apps/backend/approvals/load.py`).
 *
 * Read from the settings file at each spawn and normalized on the way out;
 * the backend normalizes it again, and an unknown value is `observe` on both
 * sides, never `enforce`.
 */

import { normalizeApprovalTierMode } from "../../shared/utils/approval-tiers";
import { readSettingsFile } from "../settings-utils";

export const APPROVALS_ENV = "WORKPILOT_APPROVALS";

export function approvalsEnv(
	settings: Record<string, unknown> | undefined = readSettingsFile(),
): Record<string, string> {
	return { [APPROVALS_ENV]: normalizeApprovalTierMode(settings?.approvalTiers) };
}
