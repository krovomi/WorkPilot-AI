/** @vitest-environment jsdom */
/**
 * The audit trail of the project's agents, and the context packer.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditTrailPanel } from "../AuditTrailPanel";
import { CogContextPanel } from "../CogContextPanel";
import { type Api, openWorld } from "./phase35-world";

let api: Api;
beforeEach(async () => {
	api = await openWorld();
});
afterEach(cleanup);

const event = (sequence: number, over: Record<string, unknown> = {}) => ({
	sequence,
	timestamp: 1_700_000_000,
	kind: "agent_invoked",
	actor: "coder",
	correlation_id: "spec-001",
	summary: `step ${sequence}`,
	payload: {},
	prev_hash: "",
	event_hash: `h${sequence}`,
	...over,
});

describe("AuditTrailPanel", () => {
	it("opens on the project's own trail directory, a Windows one included", () => {
		render(<AuditTrailPanel projectPath={"C:\\work\\shop\\"} />);
		expect(screen.getByLabelText("Trail storage directory")).toHaveValue("C:\\work\\shop\\.workpilot\\audit-trail");
	});

	it("asks for a directory, a trail name and a correlation ID before reading", () => {
		render(<AuditTrailPanel />);
		const dir = screen.getByLabelText("Trail storage directory");
		expect(dir).toHaveValue("");
		expect(screen.getByText("Enter a storage directory")).toBeInTheDocument();
		fireEvent.change(dir, { target: { value: "/trails" } });
		expect(screen.queryByText("Enter a storage directory")).not.toBeInTheDocument();
		fireEvent.change(dir, { target: { value: "" } });
		fireEvent.change(screen.getByLabelText("Trail name"), { target: { value: " " } });
		expect(screen.getByText("Enter a trail name")).toBeInTheDocument();
		expect(screen.getByText("Enter a correlation ID")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Events" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Verify integrity" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
	});

	it("lists the trail, replays one correlation, then lists the whole trail again", async () => {
		api.auditEvents.mockResolvedValue({ success: true, events: [event(1), event(2, { kind: "odd_kind" })] });
		api.auditReplay.mockResolvedValue({ success: true, bundle: { events: [event(2, { summary: "only this" })] } });
		render(<AuditTrailPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Events" }));
		expect(await screen.findByText("Events (2)")).toBeInTheDocument();
		expect(api.auditEvents).toHaveBeenCalledWith({ storageDir: "/work/shop/.workpilot/audit-trail", trailName: "default" });
		expect(screen.getByText(/#1 · Agent started/)).toBeInTheDocument();
		expect(screen.getByText(/#2 · odd_kind/)).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: " spec-001 " } });
		fireEvent.click(screen.getByRole("button", { name: "Replay" }));
		expect(await screen.findByText("Replay (1)")).toBeInTheDocument();
		expect(api.auditReplay).toHaveBeenCalledWith("spec-001", "/work/shop/.workpilot/audit-trail", "default");
		expect(screen.getByText("only this")).toBeInTheDocument();

		// Events used to fetch the trail again and leave the replay on screen.
		fireEvent.click(screen.getByRole("button", { name: "Events" }));
		expect(await screen.findByText("Events (2)")).toBeInTheDocument();
		expect(screen.queryByText("only this")).not.toBeInTheDocument();
	});

	it("says when a replay or the trail holds nothing", async () => {
		api.auditReplay.mockResolvedValue({ success: true, bundle: { events: [] } });
		api.auditEvents.mockResolvedValue({ success: true, events: [] });
		render(<AuditTrailPanel projectPath="/p" />);
		fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "nobody" } });
		fireEvent.click(screen.getByRole("button", { name: "Replay" }));
		expect(await screen.findByText("No event carries this correlation ID.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Events" }));
		expect(await screen.findByText("This trail holds no event yet.")).toBeInTheDocument();
	});

	it("shows a replay already read when the panel opens again", async () => {
		api.auditReplay.mockResolvedValue({ success: true, bundle: { events: [event(7)] } });
		const first = render(<AuditTrailPanel projectPath="/p" />);
		fireEvent.change(screen.getByLabelText("Correlation ID"), { target: { value: "spec-001" } });
		fireEvent.click(screen.getByRole("button", { name: "Replay" }));
		await screen.findByText("Replay (1)");
		first.unmount();
		render(<AuditTrailPanel projectPath="/p" />);
		expect(screen.getByText("Replay (1)")).toBeInTheDocument();
	});

	it("verifies the chain, and says where it breaks", async () => {
		api.auditVerify.mockResolvedValueOnce({
			success: true,
			integrity: { is_intact: true, events_checked: 12, first_broken_sequence: null, breakage_reason: null },
		});
		render(<AuditTrailPanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Verify integrity" }));
		expect(await screen.findByText("Chain is intact")).toBeInTheDocument();
		expect(screen.getByText("12 events checked")).toBeInTheDocument();
		api.auditVerify.mockResolvedValueOnce({
			success: true,
			integrity: {
				is_intact: false,
				events_checked: 4,
				first_broken_sequence: 4,
				breakage_reason: "prev_hash mismatch at sequence 4",
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Verify integrity" }));
		expect(await screen.findByText("Chain has been tampered with")).toBeInTheDocument();
		expect(screen.getByText("The chain breaks at event #4.")).toBeInTheDocument();
		expect(screen.getByText("prev_hash mismatch at sequence 4")).toBeInTheDocument();
	});
});

const slice = (path: string, over: Record<string, unknown> = {}) => ({
	file_path: path,
	content: `// ${path}`,
	full_size_tokens: 900,
	included_tokens: 120,
	truncated: false,
	relevance: {
		file_path: path,
		score: 0.5,
		keyword_hits: 1,
		path_score: 0,
		explicit_mention: false,
		recency_score: 0,
		breakdown: {},
	},
	...over,
});

describe("CogContextPanel", () => {
	it("picks files in the project, shown relative to it, and packs them", async () => {
		api.selectFiles
			.mockResolvedValueOnce(["/work/shop/src/a.ts", "/work/shop/src/b.ts", "/elsewhere/c.ts"])
			.mockResolvedValueOnce(["/work/shop/src/a.ts", "/work/shop/README.md"]);
		api.optimizeContext.mockResolvedValue({
			success: true,
			context: {
				slices: [slice("src/a.ts", { truncated: true })],
				token_budget: 2000,
				tokens_used: 500,
				files_skipped: ["src/b.ts"],
				summary: {},
				refused: [
					{ path: "/elsewhere/c.ts", reason: "outside" },
					{ path: "/x.bin", reason: "weird" },
				],
			},
		});
		render(<CogContextPanel projectPath="/work/shop" />);
		expect(screen.getByText(/No file chosen/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add files…" }));
		expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
		expect(api.selectFiles).toHaveBeenCalledWith({ multi: true, title: "Add files…", defaultPath: "/work/shop" });
		expect(screen.getByText("(3 files chosen)")).toBeInTheDocument();
		expect(screen.getByText("/elsewhere/c.ts")).toBeInTheDocument();
		// A file picked twice is listed once; one at the project's root is named by itself.
		fireEvent.click(screen.getByRole("button", { name: "Add files…" }));
		expect(await screen.findByText("(4 files chosen)")).toBeInTheDocument();
		expect(screen.getAllByText("README.md")).toHaveLength(2);
		fireEvent.click(screen.getAllByRole("button", { name: "Remove this file" })[3]);
		fireEvent.click(screen.getAllByRole("button", { name: "Remove this file" })[1]);
		expect(screen.getByText("(2 files chosen)")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Token budget"), { target: { value: "2000" } });
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "  fix the total " } });
		fireEvent.click(screen.getByRole("button", { name: "Optimize" }));
		expect(await screen.findByText("Included : 1")).toBeInTheDocument();
		expect(api.optimizeContext).toHaveBeenCalledWith("fix the total", ["src/a.ts", "/elsewhere/c.ts"], 2000, {
			projectDir: "/work/shop",
		});
		expect(screen.getByText("Skipped : 1")).toBeInTheDocument();
		expect(screen.getByText("Fill ratio : 25 %")).toBeInTheDocument();
		expect(screen.getByText("Excerpt")).toBeInTheDocument();
		expect(screen.getByText("score 0.50 · 120/900 tokens")).toBeInTheDocument();
		expect(screen.getByText("Over budget: src/b.ts")).toBeInTheDocument();
		expect(screen.getByText(/outside the project/)).toBeInTheDocument();
		expect(screen.getByText(/\(\s*weird\s*\)/)).toBeInTheDocument();
		expect(screen.queryByText(/Keywords read/)).not.toBeInTheDocument();
		expect(screen.queryByText(/project sources? examined/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		expect(screen.getByText("(0 files chosen)")).toBeInTheDocument();
	});

	it("adds a typed path, and refuses an empty or a repeated one", () => {
		render(<CogContextPanel projectPath="/work/shop" />);
		const box = screen.getByLabelText("Path relative to the project");
		expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByText("Required")).toBeInTheDocument();
		fireEvent.change(box, { target: { value: "/work/shop/src/a.ts" } });
		expect(screen.queryByText("Required")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(screen.getByText("src/a.ts")).toBeInTheDocument();
		expect(box).toHaveValue("");
		fireEvent.change(box, { target: { value: "src/a.ts" } });
		fireEvent.keyDown(box, { key: "a" });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.getByText("This file is already in the list")).toBeInTheDocument();
		fireEvent.change(box, { target: { value: "src/a.t" } });
		expect(screen.queryByText("This file is already in the list")).not.toBeInTheDocument();
	});

	it("keeps the budget within what the backend accepts", () => {
		render(<CogContextPanel projectPath="/work/shop" />);
		const budget = screen.getByLabelText("Token budget");
		fireEvent.change(budget, { target: { value: "50" } });
		expect(screen.getByText("Budget must be ≥ 100 tokens")).toBeInTheDocument();
		fireEvent.change(budget, { target: { value: "" } });
		expect(screen.getByText("Budget must be ≥ 100 tokens")).toBeInTheDocument();
		fireEvent.change(budget, { target: { value: "300000" } });
		expect(screen.getByText("Budget must be ≤ 200,000 tokens")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "x" } });
		expect(screen.getByRole("button", { name: "Optimize" })).toBeDisabled();
	});

	it("says the file dialog failed instead of doing nothing", async () => {
		api.selectFiles.mockRejectedValue(new Error("no window"));
		render(<CogContextPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Add files…" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The file dialog could not open.");
	});

	it("proposes the project's sources, copies the context, and says when the clipboard refuses", async () => {
		const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		api.optimizeContext.mockResolvedValue({
			success: true,
			context: {
				slices: [slice("src/a.ts")],
				token_budget: 8000,
				tokens_used: 120,
				files_skipped: [],
				summary: { candidates: 4, keywords_detected: ["order"] },
				discovered: true,
			},
		});
		render(<CogContextPanel projectPath="/work/shop" />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "orders" } });
		fireEvent.click(screen.getByRole("button", { name: "Optimize" }));
		expect(await screen.findByText("4 project sources examined (no file chosen).")).toBeInTheDocument();
		expect(screen.getByText("Keywords read in the task: order")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Copy the context" }));
		expect(await screen.findByRole("button", { name: "Context copied" })).toBeInTheDocument();
		expect(writeText).toHaveBeenCalledWith("### src/a.ts\n```\n// src/a.ts\n```");
		fireEvent.click(screen.getByRole("button", { name: "Context copied" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The clipboard refused the copy.");
		expect(screen.getByRole("button", { name: "Copy the context" })).toBeInTheDocument();
	});

	it("says when no file fits, with a budget-less context", async () => {
		api.optimizeContext.mockResolvedValue({
			success: true,
			context: { slices: [], token_budget: 0, tokens_used: 0, files_skipped: [], summary: {}, discovered: true },
		});
		render(<CogContextPanel projectPath="/work/shop" />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "orders" } });
		fireEvent.click(screen.getByRole("button", { name: "Optimize" }));
		expect(await screen.findByText("No file could be included.")).toBeInTheDocument();
		expect(screen.getByText("Fill ratio : 0 %")).toBeInTheDocument();
		expect(screen.getByText("0 project sources examined (no file chosen).")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Copy the context" })).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Optimize" })).toBeEnabled());
	});

	it("asks for a project", () => {
		render(<CogContextPanel />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
	});
});
