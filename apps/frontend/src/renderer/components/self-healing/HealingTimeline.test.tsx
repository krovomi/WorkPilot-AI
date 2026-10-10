/**
 * @vitest-environment jsdom
 */
/**
 * An operation that fixed nothing is not shown as healed or as a crash: its
 * unrun steps say "skipped", and an escalated incident says it needs review.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type {
	HealingOperation,
	Incident,
} from "../../../shared/types/self-healing";
import { HealingTimeline } from "./HealingTimeline";
import { IncidentCard } from "./IncidentCard";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const REASON = "No fix was generated: a person has to take it from here.";

const incident: Incident = {
	id: "abc123",
	mode: "cicd",
	source: "git_push",
	severity: "medium",
	title: "Test regression",
	description: "Tests broke",
	status: "escalated",
	created_at: "2026-10-10T00:00:00",
	source_data: {},
	affected_files: [],
	error_message: REASON,
};

const operation: HealingOperation = {
	id: "op1",
	incident,
	started_at: "2026-10-10T00:00:00",
	completed_at: "2026-10-10T00:00:05",
	steps: [
		{ name: "Analyzing incident", status: "completed", detail: "Prompt built" },
		{
			name: "Generating fix in isolated worktree",
			status: "skipped",
			detail: "not run: no fixer session is wired to the healing pipeline yet",
		},
	],
	duration_seconds: 5,
	success: false,
};

describe("HealingTimeline", () => {
	it("says an escalated operation needs review, not that it failed", () => {
		render(<HealingTimeline operation={operation} />);

		expect(screen.getByText("selfHealing:needsReview")).toBeInTheDocument();
		expect(screen.queryByText("selfHealing:resolved")).not.toBeInTheDocument();
		expect(screen.queryByText("selfHealing:failed")).not.toBeInTheDocument();
	});

	it("labels a step that did not run as skipped, with its reason", () => {
		render(<HealingTimeline operation={operation} />);

		expect(screen.getAllByText("selfHealing:stepSkipped")).toHaveLength(1);
		expect(
			screen.getByText(
				"not run: no fixer session is wired to the healing pipeline yet",
			),
		).toBeInTheDocument();
	});
});

describe("IncidentCard", () => {
	it("shows why an escalated incident needs a person", () => {
		render(<IncidentCard incident={incident} />);

		expect(
			screen.getByText(`selfHealing:needsReview — ${REASON}`),
		).toBeInTheDocument();
	});
});
