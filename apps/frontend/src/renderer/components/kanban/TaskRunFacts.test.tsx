/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../shared/i18n";
import type { Task, TaskRunFacts, TaskStatusTransition } from "../../../shared/types";
import { sameRunFacts, TaskRunFactsDetails, TaskRunFactsRow } from "./TaskRunFacts";

const history: TaskStatusTransition[] = [
	{ from: null, to: "backlog", at: "2026-11-27T09:00:00Z", actor: "user" },
	{ from: "backlog", to: "in_progress", at: "2026-11-27T09:10:00Z", actor: "user" },
	{ from: "in_progress", to: "human_review", reason: "completed", at: "2026-11-27T09:22:00Z", actor: "agent" },
	{ from: "human_review", to: "done", at: "2026-11-27T11:15:00Z", actor: "user" },
];

const usage = {
	inputTokens: 40_000,
	outputTokens: 8_000,
	cacheReadTokens: 1_500,
	cacheWriteTokens: 500,
	costUsd: 0.5,
	sessions: 4,
	estimatedSessions: 0,
	models: ["claude-sonnet", "llama3"],
};

function task(runFacts?: TaskRunFacts, extra: Partial<Task> = {}): Task {
	return {
		id: "t",
		specId: "001-t",
		projectId: "p",
		title: "T",
		description: "",
		status: "done",
		subtasks: [],
		logs: [],
		statusHistory: history,
		createdAt: new Date(),
		updatedAt: new Date(),
		...(runFacts && { runFacts }),
		...extra,
	};
}

beforeAll(async () => {
	await i18n.changeLanguage("en");
});

describe("TaskRunFactsRow", () => {
	it("shows the agents' time, the tokens, the cost and who created and launched it", () => {
		render(
			<TaskRunFactsRow
				task={task({
					createdBy: { kind: "person", name: "Alice" },
					startedBy: { kind: "person", name: "Bob" },
					usage,
				})}
			/>,
		);
		const row = screen.getByTestId("task-run-facts");
		expect(row).toHaveTextContent("12 min");
		expect(row).toHaveTextContent("50K tokens");
		expect(row).toHaveTextContent("€");
		expect(row).toHaveTextContent("Alice → Bob");
		expect(screen.getAllByText("Created by Alice, launched by Bob")[0]).toBeInTheDocument();
	});

	it("names one person once, and says what is unknown", () => {
		render(
			<TaskRunFactsRow
				task={task(
					{
						createdBy: { kind: "person", name: "Léa" },
						startedBy: { kind: "person", name: "Léa" },
					},
					{ statusHistory: undefined },
				)}
			/>,
		);
		const row = screen.getByTestId("task-run-facts");
		expect(row).toHaveTextContent("unknown");
		expect(row).toHaveTextContent("Tokens unknown");
		expect(row).not.toHaveTextContent("→");
		expect(row).toHaveTextContent("Léa");
	});

	it("marks estimated tokens and leaves out a cost nobody priced", () => {
		render(
			<TaskRunFactsRow
				task={task({ usage: { ...usage, costUsd: 0, estimatedSessions: 1 } })}
			/>,
		);
		const row = screen.getByTestId("task-run-facts");
		expect(row).toHaveTextContent("≈ 50K tokens");
		expect(row).not.toHaveTextContent("€");
	});

	it("shows nothing before the agents are done", () => {
		const { container } = render(
			<TaskRunFactsRow task={task({ usage }, { status: "in_progress" })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("TaskRunFactsDetails", () => {
	it("details the times, tokens, cost, models and people in French", async () => {
		await i18n.changeLanguage("fr");
		render(
			<TaskRunFactsDetails
				task={task({
					createdBy: { kind: "automation" },
					startedBy: { kind: "person", name: "Bob" },
					usage: { ...usage, estimatedSessions: 1 },
				})}
			/>,
		);
		const details = screen.getByTestId("task-run-facts-details");
		expect(details).toHaveTextContent("Temps de travail des agents : 12 min");
		expect(details).toHaveTextContent("Du lancement à la fin : 2 h 5 min");
		expect(details).toHaveTextContent("Modèles : claude-sonnet, llama3");
		expect(details).toHaveTextContent("Créée par : Automatisation");
		expect(details).toHaveTextContent("Lancée par : Bob");
		expect(details).toHaveTextContent("1 session sur 4 estimée");
		await i18n.changeLanguage("en");
	});

	it("says unknown for every part nobody reported", () => {
		render(<TaskRunFactsDetails task={task(undefined, { statusHistory: [] })} />);
		const details = screen.getByTestId("task-run-facts-details");
		expect(details).toHaveTextContent("Tokens: unknown");
		expect(details).toHaveTextContent("Cost: unknown");
		expect(details).toHaveTextContent("Created by: unknown");
	});

	it("shows nothing on an unfinished card", () => {
		const { container } = render(
			<TaskRunFactsDetails task={task(undefined, { status: "backlog" })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("sameRunFacts", () => {
	it("sees a change of people, spend or history", () => {
		const a = task({ createdBy: { kind: "person", name: "A" }, usage });
		expect(sameRunFacts(a, { ...a })).toBe(true);
		expect(sameRunFacts(a, task({ createdBy: { kind: "person", name: "B" }, usage }))).toBe(false);
		expect(sameRunFacts(a, task({ createdBy: { kind: "person", name: "A" } }))).toBe(false);
		expect(sameRunFacts(a, { ...a, statusHistory: history.slice(1) })).toBe(false);
	});
});
