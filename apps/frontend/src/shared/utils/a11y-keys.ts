import type { A11yViolation } from "../types/accessibility";

/** What tells two dynamic accessibility findings apart (#391). */
export function dynamicKey(v: A11yViolation): string {
	return `${v.ruleId}|${v.file}|${v.element}|${v.detail ?? ""}`;
}
