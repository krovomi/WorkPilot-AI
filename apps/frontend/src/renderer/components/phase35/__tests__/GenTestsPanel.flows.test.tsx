/** @vitest-environment jsdom */
/**
 * Generational tests in English: choosing the command, comparing a run or a
 * report with a generation, stopping a run, deleting a generation, and what
 * each error and each comparison says.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useGenTestsStore } from "../../../stores/phase35-stores";
import { describeGenError, GenTestsPanel } from "../GenTestsPanel";
import { type Api, deferred, openWorld } from "./phase35-world";

const gen = (label: string, source: string, over: Record<string, unknown> = {}) => ({
	label,
	captured_at: 1_763_000_000,
	source,
	total: 3,
	passed: 3,
	failed: 0,
	error: 0,
	skipped: 0,
	...over,
});

const COMMANDS = [
	{ id: "pytest", label: "Python", command: "pytest -q" },
	{ id: "vitest", label: "Vitest", command: "pnpm vitest run" },
];

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

let api: Api;
beforeEach(async () => {
	api = await openWorld({
		listGenerations: async () => ({
			success: true,
			details: [
				gen("new", "junit:abc"),
				gen("older", "weird:1", { failed: 1, error: 1, skipped: 2 }),
				gen("oldest", ""),
			],
		}),
		detectGenTestCommands: async () => ({ success: true, commands: COMMANDS }),
	});
});
afterEach(cleanup);

async function pick(trigger: HTMLElement, option: string) {
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("GenTestsPanel", () => {
	it("asks for a project", () => {
		render(<GenTestsPanel projectPath="" />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
		expect(api.listGenerations).not.toHaveBeenCalled();
	});

	it("names where each generation came from", async () => {
		render(<GenTestsPanel projectPath="/p" />);
		expect(await screen.findByText("JUnit XML report")).toBeInTheDocument();
		expect(screen.getByText("weird report")).toBeInTheDocument();
		expect(screen.getByText("— report")).toBeInTheDocument();
		expect(screen.getByText("2 failed")).toBeInTheDocument();
		expect(screen.getByText("2 skipped")).toBeInTheDocument();
		expect(screen.getByText("Stored generations (3)")).toBeInTheDocument();
	});

	it("runs the chosen command and compares it with the chosen generation", async () => {
		api.runGenTests.mockResolvedValue({
			success: true,
			command: "pnpm vitest run",
			report: {
				baseline_label: "older",
				current_captured_at: 0,
				regression_count: 0,
				summary: {},
				items: [],
			},
		});
		render(<GenTestsPanel projectPath="/p" />);
		expect(await screen.findByText("pytest -q")).toBeInTheDocument();
		await pick(screen.getByRole("combobox", { name: "Test command" }), "Vitest");
		expect(screen.getByText("pnpm vitest run")).toBeInTheDocument();
		await pick(screen.getByRole("combobox", { name: "Baseline generation" }), "older");
		fireEvent.click(screen.getByRole("button", { name: "Run and compare" }));
		await waitFor(() => expect(api.runGenTests).toHaveBeenCalledWith("/p", "compare", "older", "vitest"));
		expect(await screen.findByText("Compared with older")).toBeInTheDocument();
		expect(screen.getByText(/No difference/)).toBeInTheDocument();
		expect(screen.getByText("Last run: pnpm vitest run")).toBeInTheDocument();
	});

	it("shows the running suite and stops it", async () => {
		const run = deferred<unknown>();
		api.runGenTests.mockReturnValue(run.promise);
		api.cancelGenTests.mockResolvedValue(true);
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("pytest -q");
		fireEvent.click(screen.getByRole("button", { name: "Run and capture" }));
		expect(await screen.findByText("Running the project's tests…")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(api.cancelGenTests).toHaveBeenCalled();
		await act(async () => run.resolve({ success: false, error: "timed_out: killed after 30 min" }));
		expect(screen.getByRole("alert")).toHaveTextContent("The tests ran longer than 30 minutes and were stopped.");
		expect(screen.getByText("killed after 30 min")).toBeInTheDocument();
	});

	it("compares a pasted report, listing what changed by kind", async () => {
		api.compareGeneration.mockResolvedValue({
			success: true,
			format: "mystery",
			report: {
				baseline_label: "new",
				current_captured_at: 0,
				regression_count: 1,
				summary: { regressed: 1, added: 1 },
				items: [
					{ test_id: "t.added", kind: "added", baseline_status: null, current_status: "passed", baseline_duration: null, current_duration: 0.5, detail: "" },
					{ test_id: "t.odd", kind: "odd_kind", baseline_status: null, current_status: null, baseline_duration: 2, current_duration: 3.456, detail: "kept quiet" },
					{ test_id: "t.slow", kind: "slowed_down", baseline_status: "passed", current_status: "passed", baseline_duration: 0.1, current_duration: 1.5, detail: "slower" },
					{ test_id: "t.broke", kind: "regressed", baseline_status: "passed", current_status: "failed", baseline_duration: 0.01, current_duration: 0.02, detail: "AssertionError" },
					{ test_id: "t.new", kind: "new_failure", baseline_status: null, current_status: "failed", baseline_duration: null, current_duration: 0.2, detail: "" },
				],
			},
		});
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("pytest -q");
		fireEvent.click(screen.getByRole("tab", { name: "Import or paste a report" }));
		const box = screen.getByLabelText("Or paste a test report here");
		expect(screen.getByRole("button", { name: "Compare this report" })).toBeDisabled();
		fireEvent.change(box, { target: { value: "<testsuite/>" } });
		fireEvent.click(screen.getByRole("button", { name: "Compare this report" }));
		await waitFor(() => expect(api.compareGeneration).toHaveBeenCalledWith("/p", "new", "<testsuite/>"));
		expect(await screen.findByText("Compared with new")).toBeInTheDocument();
		const items = within(screen.getByText("Compared with new").closest("section") as HTMLElement).getAllByRole("listitem");
		expect(items.map((li) => li.querySelector("code")?.textContent)).toEqual(["t.odd", "t.broke", "t.new", "t.slow", "t.added"]);
		// A format the app has no name for is said as the backend gave it, not as a key.
		expect(screen.getByText("Last report read: mystery")).toBeInTheDocument();
		expect(screen.getByText("AssertionError")).toBeInTheDocument();
		expect(screen.queryByText("slower")).not.toBeInTheDocument();
		expect(screen.queryByText("kept quiet")).not.toBeInTheDocument();
		expect(screen.getByText("odd_kind")).toBeInTheDocument();
		expect(screen.getByText("— → 500 ms")).toBeInTheDocument();
		expect(screen.getByText("2.00 s → 3.46 s")).toBeInTheDocument();
	});

	it("leaves the report as it was when the import is cancelled", async () => {
		api.importGenTestsReport.mockResolvedValue({ success: false, error: "cancelled" });
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("pytest -q");
		fireEvent.click(screen.getByRole("tab", { name: "Import or paste a report" }));
		fireEvent.click(screen.getByRole("button", { name: "Import a file…" }));
		await waitFor(() => expect(api.importGenTestsReport).toHaveBeenCalled());
		expect(screen.getByLabelText("Or paste a test report here")).toHaveValue("");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("offers to import a report when the project has no command", async () => {
		api.detectGenTestCommands.mockResolvedValue({ success: true, commands: [] });
		render(<GenTestsPanel projectPath="/p" />);
		fireEvent.click(await screen.findByRole("button", { name: "Import a report" }));
		expect(screen.getByLabelText("Or paste a test report here")).toBeInTheDocument();
	});

	it("says a generation name is taken, and deletes a generation", async () => {
		api.deleteGeneration.mockResolvedValue({ success: true, deleted: true });
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("pytest -q");
		fireEvent.change(screen.getByLabelText("Generation name"), { target: { value: "older" } });
		expect(screen.getByText(/A generation already has this name/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Delete generation oldest" }));
		await waitFor(() => expect(api.deleteGeneration).toHaveBeenCalledWith("/p", "oldest"));
	});

	it("says there is nothing to compare with before a first capture", async () => {
		api.listGenerations.mockResolvedValue({ success: true, details: [] });
		render(<GenTestsPanel projectPath="/p" />);
		expect(await screen.findByText("No generation yet")).toBeInTheDocument();
		expect(screen.getByText("Capture a generation first to compare against it.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run and compare" })).toBeDisabled();
	});

	it("keeps the label when a capture fails", async () => {
		api.runGenTests.mockResolvedValue({ success: false, error: "busy" });
		render(<GenTestsPanel projectPath="/p" />);
		await screen.findByText("pytest -q");
		fireEvent.change(screen.getByLabelText("Generation name"), { target: { value: "mine" } });
		fireEvent.click(screen.getByRole("button", { name: "Run and capture" }));
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.getByLabelText("Generation name")).toHaveValue("mine");
		act(() => useGenTestsStore.setState({ error: "something else" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Backend error: something else");
	});
});

describe("describeGenError", () => {
	const t = i18n.getFixedT("en", "phase35");

	it("words a busy runner, and keeps an unknown code in the backend's words", () => {
		expect(describeGenError("busy", t).message).toBe(t("genTests.errors.run.busy"));
		expect(describeGenError("report.melted", t).message).toBe("Backend error: report.melted");
		expect(describeGenError("exploded: again", t).message).toBe("Backend error: exploded: again");
	});
});
