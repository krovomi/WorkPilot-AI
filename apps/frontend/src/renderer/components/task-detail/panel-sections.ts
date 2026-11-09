/**
 * Where each card of the task panel lives.
 *
 * The Overview tab of the task panel holds about twenty cards, each written by
 * a different feature. They used to be stacked in four scrolled sections; they
 * are now grouped in three tabs, by the question the person is asking:
 *
 * | Tab | Answers | Cards |
 * |---|---|---|
 * | **Progress** (Avancement) | where is the task, and what does it need from me to move on? | spec interview and execution formula (prerequisites), the agent's question, the human review (plan approval included), the CI pipeline, the PR follow-through, the task itself, goal mode, Best-of-N, the MCP Apps views of the build |
 * | **Quality** (Qualité) | is what was built right? | JEV second opinion, spec traceability, UI/UX design system, visual review (OCR), verification loop, red team |
 * | **Costs & context** (Coûts et contexte) | what does it cost, and what do the agents read and remember? | workflow profile (what the effort level buys), attachments and ADRs, hermes learning, shared brain, rtk savings |
 *
 * The other tabs of the panel (Subtasks, Logs, Files, Change graph, Visual
 * proof, Emulator, Mobile, Verification, Architecture delta) are full-height
 * views, not cards: they stay tabs of the panel itself. The three that judge
 * the work (Visual proof, Verification, Architecture delta) would belong to
 * Quality; the Quality cards that have a detailed view link to it.
 *
 * Each card still decides alone whether it has something to say (most return
 * nothing when they do not); `PanelCardSlot` observes that and hides the slot,
 * so the mapping here never duplicates a card's display rule.
 */

export type PanelSectionId = "progress" | "quality" | "costs";

export const PANEL_SECTIONS: readonly PanelSectionId[] = ["progress", "quality", "costs"];

export type PanelCardId =
	// Progress
	| "specInterview"
	| "executionFormula"
	| "permission"
	| "review"
	| "ciPipeline"
	| "prFollowup"
	| "task"
	| "goal"
	| "bestOfN"
	| "mcpApps"
	// Quality
	| "jev"
	| "traceability"
	| "uiux"
	| "visualReview"
	| "verifyLoop"
	| "redTeam"
	// Costs & context
	| "workflowProfile"
	| "documents"
	| "hermes"
	| "brain"
	| "rtk";

/** Each card's tab, in the order the cards are shown inside it. */
export const PANEL_CARDS: Readonly<Record<PanelSectionId, readonly PanelCardId[]>> = {
	progress: [
		"specInterview",
		"executionFormula",
		"permission",
		"review",
		"ciPipeline",
		"prFollowup",
		"task",
		"goal",
		"bestOfN",
		"mcpApps",
	],
	quality: ["jev", "traceability", "uiux", "visualReview", "verifyLoop", "redTeam"],
	costs: ["workflowProfile", "documents", "hermes", "brain", "rtk"],
};

export function sectionOfCard(card: PanelCardId): PanelSectionId {
	for (const section of PANEL_SECTIONS) {
		if (PANEL_CARDS[section].includes(card)) return section;
	}
	// Unreachable while every id is listed above (pinned by panel-sections.test.ts).
	return "progress";
}

export function panelCardDomId(taskId: string, card: PanelCardId): string {
	return `task-${taskId}-card-${card}`;
}

export function panelTabDomId(taskId: string, section: PanelSectionId): string {
	return `task-${taskId}-panel-tab-${section}`;
}

export function panelTabPanelDomId(taskId: string, section: PanelSectionId): string {
	return `task-${taskId}-panel-${section}`;
}

/** The failure banner sits above the tabs: a target of its own. */
export function failureBannerDomId(taskId: string): string {
	return `task-${taskId}-failure`;
}
