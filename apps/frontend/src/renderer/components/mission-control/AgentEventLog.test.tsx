/**
 * The live event feed: newest first, each event in words, the agent it is
 * about, its task or error, and its time in the app's language.
 */
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { formatAppTime } from "../../lib/date-format";
import type { AgentSlot, MCEvent } from "../../stores/mission-control-store";
import { AgentEventLog } from "./AgentEventLog";

const agents = [{ id: "a1", name: "Agent Coder" }, { id: "a2", name: "Agent Tester" }] as AgentSlot[];
const at = Date.UTC(2026, 10, 20, 14, 5, 9) / 1000;

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentEventLog", () => {
	it("says so when nothing has happened yet", () => {
		render(<AgentEventLog events={[]} agents={agents} />);
		expect(screen.getByText("No events yet")).toBeInTheDocument();
	});

	it("lists the newest event first, in words, with its agent, task, error and time", () => {
		const events: MCEvent[] = [
			{ type: "agent_created", timestamp: at, data: { agent_id: "a1", name: "Agent Coder" } },
			{ type: "agent_started", timestamp: at + 1, data: { agent_id: "a1", task: "Fix the login" } },
			{ type: "agent_failed", timestamp: at + 2, data: { agent_id: "a1", error: "Rate limited" } },
			{ type: "agent_removed", timestamp: at + 3, data: { agent_id: "gone1234" } },
		];
		render(<AgentEventLog events={events} agents={agents} />);
		const titles = screen.getAllByText(/^Agent (created|started|failed|removed)$/).map((el) => el.textContent);
		expect(titles).toEqual(["Agent removed", "Agent failed", "Agent started", "Agent created"]);
		expect(screen.queryByText("agent_started")).toBeNull();
		expect(screen.getAllByText("Agent Coder")).toHaveLength(3);
		// A removed agent is still named by its id.
		expect(screen.getByText("gone1234")).toBeInTheDocument();
		expect(screen.getByText("Fix the login")).toBeInTheDocument();
		expect(screen.getByText("Rate limited")).toHaveClass("text-destructive");
		const time = formatAppTime(new Date((at + 1) * 1000), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		const started = screen.getByText("Agent started").closest("div.flex-1")?.parentElement as HTMLElement;
		expect(within(started).getByText(time)).toBeInTheDocument();
	});

	it("names every kind of event the backend logs", () => {
		const types: MCEvent["type"][] = [
			"agent_paused",
			"agent_resumed",
			"agent_stopped",
			"agent_config_updated",
			"agent_completed",
		];
		render(
			<AgentEventLog
				events={types.map((type, i) => ({ type, timestamp: at + i, data: { agent_id: "a2" } }))}
				agents={agents}
			/>,
		);
		for (const text of ["Agent paused", "Agent resumed", "Agent stopped", "Agent settings changed", "Agent answered"]) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
	});

	it("keeps both rows when two agents log the same event in the same instant", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		render(
			<AgentEventLog
				events={[
					{ type: "agent_started", timestamp: at, data: { agent_id: "a1", task: "Build" } },
					{ type: "agent_started", timestamp: at, data: { agent_id: "a2", task: "Test" } },
				]}
				agents={agents}
			/>,
		);
		expect(screen.getAllByText("Agent started")).toHaveLength(2);
		expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
	});
});
