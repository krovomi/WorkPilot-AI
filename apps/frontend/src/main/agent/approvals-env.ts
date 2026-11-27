/**
 * The approval tier switches (Settings, Approval tiers) as the variables the
 * PR follow-through reads:
 *
 * - `WORKPILOT_APPROVALS` (`apps/backend/approvals/load.py`): off, observe or
 *   enforce; an unknown value is `observe` on both sides, never `enforce`;
 * - `WORKPILOT_CLAUDE_SHIP` (`apps/backend/pr_followup/claude_ship.py`): `1`
 *   when the Claude Ship adapter runs, forced in Settings or, in `auto`,
 *   because a signed-in Claude account is on a Team or Enterprise plan.
 *
 * Read from the settings file and the Claude profiles at each spawn.
 */

import type { ClaudeShipStatus } from "../../shared/types/approvals";
import {
	claudeShipActive,
	normalizeApprovalTierMode,
	normalizeClaudeShipMode,
} from "../../shared/utils/approval-tiers";
import { accountsWithPlan } from "../ai-accounts/account-plans";
import { readSettingsFile } from "../settings-utils";

export const APPROVALS_ENV = "WORKPILOT_APPROVALS";
export const CLAUDE_SHIP_ENV = "WORKPILOT_CLAUDE_SHIP";

/** The signed-in Claude accounts on a Team or Enterprise organization. */
export function claudeShipStatus(
	accounts: ReturnType<typeof accountsWithPlan> = accountsWithPlan("anthropic"),
): ClaudeShipStatus {
	const found = accounts
		.filter((a) => a.signedIn && (a.plan === "team" || a.plan === "enterprise"))
		.map((a) => ({ name: a.name.slice(0, 100), plan: a.plan as "team" | "enterprise" }));
	return { detected: found.length > 0, accounts: found };
}

export function approvalsEnv(
	settings: Record<string, unknown> | undefined = readSettingsFile(),
	detected: () => boolean = () => claudeShipStatus().detected,
): Record<string, string> {
	const mode = normalizeClaudeShipMode(settings?.claudeShip);
	// `detected` reads the Claude profiles: only when `auto` needs it.
	const ship = mode === "auto" ? claudeShipActive(mode, detected()) : claudeShipActive(mode, false);
	return {
		[APPROVALS_ENV]: normalizeApprovalTierMode(settings?.approvalTiers),
		[CLAUDE_SHIP_ENV]: ship ? "1" : "0",
	};
}
