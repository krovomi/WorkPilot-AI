/**
 * Words for the values the server sends as keys: a card's status, a work
 * session's phase, a role. Each falls back to the key itself for a value this
 * version does not know (a custom role, a future phase), never to nothing.
 */

import i18n from "./index";

function first(keys: readonly string[], fallback: string): string {
	for (const key of keys) if (i18n.exists(key)) return i18n.t(key);
	return fallback;
}

/** A board status (`implementation_plan.json`), in the dashboard's words or the column's. */
export function statusLabel(status: string): string {
	return first([`dashboard.status.${status}`, `columns.${status}`], status);
}

/**
 * What a work session did: a run phase (`build`), a feature job (`roadmap`,
 * `ideation`, `insights`), an analysis (`analysis-tech-debt`) or a forge
 * review (`github-review`).
 */
export function phaseLabel(phase: string): string {
	const analysis = /^analysis-(.+)$/.exec(phase);
	if (analysis) {
		return first([`analyses.kinds.${analysis[1]}.title`], phase);
	}
	return first([`runPhase.${phase}`, `features.${phase}`], phase);
}

/** A role on a project: owner, member, viewer. */
export function projectRoleLabel(role: string): string {
	return first([`admin.projectRole.${role}`], role);
}

/** A built-in organization role by its slug; a custom role keeps its slug. */
export function orgRoleLabel(slug: string): string {
	return first([`orgRole.${slug}`], slug);
}
