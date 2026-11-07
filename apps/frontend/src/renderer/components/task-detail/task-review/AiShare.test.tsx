/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import "../../../../shared/i18n";
import { AiFileShare, AiTaskShare } from "./AiShare";

describe("AI share", () => {
	it("shows a file's share and the task's, with the model", () => {
		render(
			<>
				<AiFileShare
					file={{
						path: "src/Cart.vue",
						status: "modified",
						additions: 10,
						deletions: 0,
						attribution: { added: 10, ai: 8, human: 2, unknown: 0 },
					}}
				/>
				<AiTaskShare
					attribution={{
						added: 40,
						ai: 30,
						human: 10,
						unknown: 0,
						models: { "anthropic/claude-sonnet-5-5": 30 },
					}}
				/>
			</>,
		);
		expect(screen.getByText("AI 80%")).toBeInTheDocument();
		expect(
			screen.getByText(
				"75% of the 40 added lines were written by the agent (anthropic/claude-sonnet-5-5), 25% by you (Agent Trace)",
			),
		).toBeInTheDocument();
	});

	it("shows nothing for a task without a record", () => {
		const { container } = render(
			<>
				<AiFileShare file={{ path: "a", status: "added", additions: 1, deletions: 0 }} />
				<AiTaskShare />
			</>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
