/**
 * The log of a PR review, phase by phase: each specialist's lines under its
 * name, the orchestrator's tool calls folded into a count, errors and
 * details opened on demand, all in the app's language.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
	PRLogEntry,
	PRLogs as PRLogsData,
	PRPhaseLog,
} from "../../../../../preload/api/modules/github-api";
import i18n from "../../../../../shared/i18n";
import { PRLogs } from "../PRLogs";

const T = "2026-11-15T10:00:00Z";
const entry = (content: string, fields: Partial<PRLogEntry> = {}): PRLogEntry => ({
	timestamp: T,
	type: "text",
	content,
	phase: "analysis",
	...fields,
});
const phase = (
	name: PRPhaseLog["phase"],
	status: PRPhaseLog["status"],
	entries: PRLogEntry[] = [],
): PRPhaseLog => ({ phase: name, status, started_at: null, completed_at: null, entries });

function logs(analysis: PRLogEntry[], fields: Partial<PRLogsData> = {}): PRLogsData {
	return {
		pr_number: 7,
		repo: "o/r",
		created_at: T,
		updated_at: T,
		is_followup: false,
		phases: {
			context: phase("context", "completed", [entry("Gathered 4 files", { source: "Context" })]),
			analysis: phase("analysis", "completed", analysis),
			synthesis: phase("synthesis", "pending"),
		},
		...fields,
	};
}

describe("PRLogs", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("waits for the logs, then says when a review has none", () => {
		const { rerender } = render(<PRLogs prNumber={7} logs={null} isLoading />);
		expect(screen.queryByText("No logs available")).toBeNull();
		rerender(<PRLogs prNumber={7} logs={null} isLoading={false} isStreaming />);
		expect(screen.getByText(i18n.t("taskReview:pr.logs.waitingForLogs"))).toBeInTheDocument();
		rerender(<PRLogs prNumber={7} logs={null} isLoading={false} />);
		expect(screen.getByText(i18n.t("taskReview:pr.logs.noLogsAvailable"))).toBeInTheDocument();
	});

	it("names the phases in the app's language, with where each stands", async () => {
		await i18n.changeLanguage("fr");
		render(<PRLogs prNumber={7} logs={logs([entry("Hello", { source: "AI" })], { is_followup: true })} isLoading={false} />);
		expect(screen.getByText("PR #7")).toBeInTheDocument();
		expect(screen.getByText("Suivi")).toBeInTheDocument();
		const context = screen.getByRole("button", { name: /Collecte du contexte/ });
		expect(within(context).getByText("Terminé")).toBeInTheDocument();
		expect(within(context).getByText("(1 entrées)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Analyse IA/ })).toBeInTheDocument();
		const synthesis = screen.getByRole("button", { name: /Synthèse/ });
		expect(within(synthesis).getByText("En attente")).toBeInTheDocument();
	});

	it("opens a phase, and says when it has no line yet", async () => {
		render(<PRLogs prNumber={7} logs={logs([entry("Hello", { source: "AI" })])} isLoading={false} />);
		// Analysis starts open, the others closed.
		expect(screen.getByText("Hello")).toBeInTheDocument();
		expect(screen.queryByText("Gathered 4 files")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /Context Gathering/ }));
		expect(screen.getByText("Gathered 4 files")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /AI Analysis/ }));
		expect(screen.queryByText("Hello")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /Synthesis/ }));
		expect(screen.getByText("No logs yet")).toBeInTheDocument();
	});

	it("follows a running review", () => {
		const running = logs([]);
		running.phases.context = phase("context", "active");
		running.phases.analysis = phase("analysis", "completed");
		const { rerender } = render(<PRLogs prNumber={7} logs={running} isLoading={false} isStreaming />);
		expect(screen.getByText("Live")).toBeInTheDocument();
		const context = screen.getByRole("button", { name: /Context Gathering/ });
		expect(within(context).getByText("Streaming")).toBeInTheDocument();
		// Marked done with nothing in it while still streaming: not done yet.
		expect(within(screen.getByRole("button", { name: /AI Analysis/ })).getByText("Pending")).toBeInTheDocument();
		expect(within(screen.getByRole("button", { name: /Synthesis/ })).getByText("Streaming")).toBeInTheDocument();

		running.phases.synthesis = phase("synthesis", "failed");
		rerender(<PRLogs prNumber={7} logs={{ ...running }} isLoading={false} />);
		expect(within(screen.getByRole("button", { name: /Context Gathering/ })).getByText("Running")).toBeInTheDocument();
		expect(within(screen.getByRole("button", { name: /Synthesis/ })).getByText("Failed")).toBeInTheDocument();
	});

	it("keeps every line, even several in the same second", () => {
		render(
			<PRLogs
				prNumber={7}
				logs={logs([entry("First", { source: "AI" }), entry("Second", { source: "AI" }), entry("Third")])}
				isLoading={false}
			/>,
		);
		for (const text of ["First", "Second", "Third"]) {
			expect(screen.getAllByText(text)).toHaveLength(1);
		}
		expect(screen.getAllByText("AI")).toHaveLength(2);
	});

	it("shows an error, a success and a note, and opens an error's details", async () => {
		render(
			<PRLogs
				prNumber={7}
				logs={logs([
					entry("Specialist crashed", { type: "error", detail: "Traceback: boom" }),
					entry("Plain failure", { type: "error", timestamp: "2026-11-15T10:00:01Z" }),
					entry("Review posted", { type: "success" }),
					entry("Using cached diff", { type: "info" }),
					entry("Raw output", { detail: "full output", source: "Unknown", timestamp: "not a date" }),
				])}
				isLoading={false}
			/>,
		);
		expect(screen.getByText("Review posted")).toBeInTheDocument();
		expect(screen.getByText("Using cached diff")).toBeInTheDocument();
		expect(screen.getByText("Plain failure")).toBeInTheDocument();

		const details = screen.getByRole("button", { name: "Show the details" });
		expect(details).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(details);
		expect(screen.getByText("Traceback: boom")).toBeInTheDocument();
		await userEvent.click(details);
		expect(screen.queryByText("Traceback: boom")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "More" }));
		expect(screen.getByText("full output")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Less" }));
		expect(screen.queryByText("full output")).toBeNull();
	});

	it("folds the orchestrator's tool calls into a count", async () => {
		await i18n.changeLanguage("fr");
		render(
			<PRLogs
				prNumber={7}
				logs={logs([
					entry("Reading src/a.ts", { source: "ParallelOrchestrator" }),
					entry("Reading src/b.ts", { source: "ParallelOrchestrator" }),
					entry("Searching for retry", { source: "ParallelFollowup", timestamp: "2026-11-15T10:00:02Z" }),
					entry("Running: npm test", { source: "ParallelOrchestrator", timestamp: "bad" }),
					entry("Invoking 3 specialists", { source: "ParallelOrchestrator" }),
				])}
				isLoading={false}
			/>,
		);
		expect(screen.getByText("Invoking 3 specialists")).toBeInTheDocument();
		const activity = screen.getByRole("button", { name: /Activité de l'agent/ });
		expect(within(activity).getByText("2 fichiers lus, 1 recherche, 1 autre")).toBeInTheDocument();
		expect(screen.queryByText("Reading src/a.ts")).toBeNull();
		await userEvent.click(activity);
		expect(screen.getByText("Reading src/a.ts")).toBeInTheDocument();
		expect(screen.getByText("Running: npm test")).toBeInTheDocument();
	});

	it("counts a single kind of tool call in the singular", () => {
		render(
			<PRLogs
				prNumber={7}
				logs={logs([entry("Writing notes.md", { source: "ParallelOrchestrator" })])}
				isLoading={false}
			/>,
		);
		expect(screen.getByText("1 other")).toBeInTheDocument();
	});

	it("puts each specialist under its name, its most telling line first", async () => {
		render(
			<PRLogs
				prNumber={7}
				logs={logs([
					entry("Starting analysis...", { source: "Specialist:security", timestamp: "2026-11-15T10:00:05Z" }),
					entry("Complete: 2 findings", { source: "Specialist:security", timestamp: "2026-11-15T10:00:09Z" }),
					entry("Processing SDK stream...", { source: "Agent:logic-reviewer", timestamp: "2026-11-15T10:00:01Z" }),
					entry("AI response: looks fine", { source: "Agent:logic-reviewer", timestamp: "2026-11-15T10:00:02Z" }),
					entry("Awaiting response stream...", { source: "Agent:quality-reviewer", timestamp: "2026-11-15T10:00:03Z" }),
					entry("Checked naming", { source: "Agent:quality-reviewer", timestamp: "2026-11-15T10:00:04Z" }),
					entry("Processing...", { source: "Specialist:logic", timestamp: "2026-11-15T10:00:06Z" }),
				])}
				isLoading={false}
			/>,
		);
		// Ordered by their first line.
		const names = screen.getAllByText(/^(security|logic-reviewer|quality-reviewer|logic)$/).map((n) => n.textContent);
		expect(names).toEqual(["logic-reviewer", "quality-reviewer", "security", "logic"]);

		expect(screen.getByText("Complete: 2 findings")).toBeInTheDocument();
		expect(screen.getByText("AI response: looks fine")).toBeInTheDocument();
		expect(screen.getByText("Checked naming")).toBeInTheDocument();
		// Nothing but boring lines: the first one stands.
		expect(screen.getByText("Processing...")).toBeInTheDocument();
		expect(screen.queryByText("Starting analysis...")).toBeNull();

		const more = screen.getAllByRole("button", { name: "Show 1 more" });
		expect(more).toHaveLength(3);
		await userEvent.click(more[2]);
		expect(screen.getByText("Starting analysis...")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Hide 1 more" }));
		expect(screen.queryByText("Starting analysis...")).toBeNull();
	});
});
