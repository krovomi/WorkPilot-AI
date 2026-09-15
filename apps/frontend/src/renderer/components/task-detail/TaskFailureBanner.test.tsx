/**
 * @vitest-environment jsdom
 */
/**
 * Tests TaskFailureBanner — la bannière qui nomme l'échec d'une tâche.
 *
 * Le défaut d'origine : une tâche en échec arrive en revue humaine avec un
 * badge rouge « Has Errors » et rien derrière. La bannière est l'endroit où la
 * phrase utile atterrit ; ces tests fixent qu'elle apparaît quand il faut, et
 * seulement quand il faut.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import type { Task } from "../../../shared/types";
import { TaskFailureBanner } from "./TaskFailureBanner";

function makeTask(overrides: Partial<Task>): Task {
	return { id: "task-1", status: "human_review", ...overrides } as Task;
}

describe("TaskFailureBanner", () => {
	it("shows the backend's message when the task failed", () => {
		render(
			<TaskFailureBanner
				task={makeTask({
					reviewReason: "errors",
					errorMessage:
						"Planning failed: the model did not produce a valid implementation_plan.json.",
				})}
			/>,
		);

		expect(
			screen.getByText(/did not produce a valid implementation_plan\.json/),
		).toBeInTheDocument();
	});

	it("still renders when the backend named no cause", () => {
		// The alternative was an empty panel, which reads as a rendering bug
		// rather than as "the detail is in the logs".
		render(<TaskFailureBanner task={makeTask({ reviewReason: "errors" })} />);

		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("renders nothing for a task that finished normally", () => {
		const { container } = render(
			<TaskFailureBanner task={makeTask({ reviewReason: "completed" })} />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for a task still running", () => {
		const { container } = render(
			<TaskFailureBanner
				task={makeTask({ status: "in_progress", reviewReason: undefined })}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("covers the standalone error status too", () => {
		render(
			<TaskFailureBanner
				task={makeTask({ status: "error", errorMessage: "exit code 137" })}
			/>,
		);

		expect(screen.getByText(/exit code 137/)).toBeInTheDocument();
	});
});
