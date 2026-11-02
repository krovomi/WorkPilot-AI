/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it } from "vitest";
import "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import { AutomationBadge } from "./AutomationBadge";

const task = (metadata: Task["metadata"]) => ({ id: "t", metadata }) as Task;

describe("AutomationBadge", () => {
	it("says Automations created the card, and which rule", () => {
		render(
			<AutomationBadge
				task={task({
					sourceType: "github",
					automation: { ruleId: "r-000000000001", ruleName: "Triage bugs", eventKey: "k" },
				})}
			/>,
		);
		const badge = screen.getByText("Automations");
		expect(badge.closest("[title]")).toHaveAttribute(
			"title",
			"Created by the automation rule “Triage bugs”",
		);
	});

	it("shows nothing on a card a person made", () => {
		const { container } = render(<AutomationBadge task={task({ sourceType: "manual" })} />);
		expect(container).toBeEmptyDOMElement();
	});
});
