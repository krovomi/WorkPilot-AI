/** @vitest-environment jsdom */
/**
 * Three scans of the project: its architecture against a baseline, its
 * dependencies' licences against a policy, and CI logs against known failures.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchDriftPanel } from "../ArchDriftPanel";
import { CicdAnomalyPanel } from "../CicdAnomalyPanel";
import { LicensePanel } from "../LicensePanel";
import { type Api, openWorld } from "./phase35-world";

let api: Api;
beforeEach(async () => {
	api = await openWorld();
});
afterEach(cleanup);

const violation = (over: Record<string, unknown> = {}) => ({
	type: "circular_dependency",
	severity: "error",
	file: "src/a.py",
	...over,
});

describe("ArchDriftPanel", () => {
	it("asks for a project before scanning", () => {
		render(<ArchDriftPanel projectPath="" />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Scan now" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Save baseline" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Compare drift" })).toBeDisabled();
	});

	it("scans the project and lists what it found, with the rule each finding breaks", async () => {
		api.scanArchitecture.mockResolvedValue({
			success: true,
			config_source: "none",
			report: {
				status: "approved",
				violations: [
					violation({ fingerprint: "f1", line: 0, rule: "no cycles" }),
					violation({ type: "new_type", file: "src/b.py", rule_id: "unknown_rule", rule: "Own rule" }),
					violation({ file: "src/c.py", rule_id: "orphan_rule" }),
					violation({ file: "src/d.py", source_layer: "domain", target_layer: "edge", import_target: "edge.http" }),
					violation({ file: "src/e.py", severity: "warning" }),
				],
				warnings: [],
				violation_count: 5,
				warning_count: 0,
				summary: "",
			},
		});
		render(<ArchDriftPanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
		expect(await screen.findByText("Compliant")).toBeInTheDocument();
		expect(api.scanArchitecture).toHaveBeenCalledWith("/p");
		expect(screen.getByText("No rule could be inferred for this project: nothing was checked.")).toBeInTheDocument();
		expect(screen.getByText("Violations (5)")).toBeInTheDocument();
		expect(screen.queryByText("Warnings (0)")).not.toBeInTheDocument();
		expect(screen.queryByText(/files analysed/)).not.toBeInTheDocument();
		// A line 0 is no line; an unknown type and rule id keep the backend's words.
		expect(screen.getByText("src/a.py")).toBeInTheDocument();
		expect(screen.getByText("no cycles")).toBeInTheDocument();
		expect(screen.getByText("new_type")).toBeInTheDocument();
		expect(screen.getByText("Own rule")).toBeInTheDocument();
		expect(screen.getByText("orphan_rule")).toBeInTheDocument();
		expect(screen.getByText("The “Domain” layer must not depend on the “edge” layer.")).toBeInTheDocument();
		expect(screen.getByText("→ edge.http")).toBeInTheDocument();
	});

	it("lists at most fifty findings, the count staying exact", async () => {
		const many = Array.from({ length: 60 }, (_, i) => violation({ file: `src/f${i}.py`, line: i + 1 }));
		api.scanArchitecture.mockResolvedValue({
			success: true,
			config_source: "explicit",
			report: { status: "rejected", violations: [], warnings: many, violation_count: 0, warning_count: 60, summary: "" },
		});
		render(<ArchDriftPanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
		expect(await screen.findByText("Warnings (60)")).toBeInTheDocument();
		expect(screen.getByText("src/f49.py:50")).toBeInTheDocument();
		expect(screen.queryByText("src/f50.py:51")).not.toBeInTheDocument();
		expect(screen.getByText("Rules read from the project architecture config.")).toBeInTheDocument();
	});

	it("saves a baseline, then compares the drift to it", async () => {
		api.saveArchBaseline.mockResolvedValue({ success: true, violation_count: 3, config_source: "inferred" });
		api.compareArchDrift.mockResolvedValue({
			success: true,
			config_source: "inferred",
			drift: {
				has_baseline: true,
				severity: "medium",
				new_violations: [violation({ file: "src/new.py" })],
				resolved_violations: [violation({ file: "src/old.py" }), violation({ file: "src/old2.py" })],
				persistent_violations: [],
				summary: {},
			},
		});
		render(<ArchDriftPanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Save baseline" }));
		expect(await screen.findByText("Baseline saved (3 findings).")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Compare drift" }));
		expect(await screen.findByText("medium")).toBeInTheDocument();
		expect(screen.getByText("New violations (1)")).toBeInTheDocument();
		expect(screen.getByText("Resolved (2)")).toBeInTheDocument();
		expect(screen.getByText("src/new.py")).toBeInTheDocument();
		expect(screen.getByText("src/old2.py")).toBeInTheDocument();
	});
});

const dep = (name: string, ecosystem = "npm") => ({ name, version: "1.0.0", ecosystem, declared_license: null });

describe("LicensePanel", () => {
	it("scans with the chosen policy, without the registries when unticked", async () => {
		api.scanLicenses.mockResolvedValue({
			success: true,
			report: {
				dependencies: [{ ...dep("gpl-lib"), is_direct: true }],
				conflicts: [
					{
						dependency: { ...dep("gpl-lib", "perl"), declared_license: "GPL-3.0" },
						category: "strong_copyleft",
						reason: "",
						remediation: "",
					},
					{ dependency: dep("mystery"), category: "unknown", reason: "", remediation: "" },
				],
				by_category: {},
				summary: { by_ecosystem: { npm: 1, perl: 1 }, by_source: { registry: 2, magic: 1 } },
				passed: false,
			},
		});
		render(<LicensePanel projectPath="/p" />);
		fireEvent.change(screen.getByLabelText("Policy"), { target: { value: "saas_safe" } });
		fireEvent.click(screen.getByRole("checkbox", { name: /Ask the public registries/ }));
		fireEvent.click(screen.getByRole("button", { name: "Scan" }));
		expect(await screen.findByText("Conflicts found")).toBeInTheDocument();
		expect(api.scanLicenses).toHaveBeenCalledWith("/p", "saas_safe", undefined, false);
		expect(screen.getByText("Dependencies: 1 · Conflicts: 1 · To check: 1")).toBeInTheDocument();
		expect(screen.getByText("GPL-3.0")).toBeInTheDocument();
		expect(screen.getByText("Strong copyleft")).toBeInTheDocument();
		expect(screen.getAllByText("perl")).toHaveLength(1);
		expect(screen.getByText("perl · 1")).toBeInTheDocument();
		expect(screen.getByText("2 from public registries · magic")).toBeInTheDocument();
		// With real conflicts listed, the licences to check stay folded away.
		expect(screen.getByText("1 dependency whose licence was not found").closest("details")).not.toHaveAttribute("open");
	});

	it("passes a project whose licences all fit, and says when no manifest was found", async () => {
		api.scanLicenses.mockResolvedValue({
			success: true,
			online: true,
			report: { dependencies: [], conflicts: [], by_category: {}, summary: {}, passed: true },
		});
		render(<LicensePanel projectPath="/p" />);
		fireEvent.click(screen.getByRole("button", { name: "Scan" }));
		expect(await screen.findByText("Compliant")).toBeInTheDocument();
		expect(api.scanLicenses).toHaveBeenCalledWith("/p", "permissive_only", undefined, true);
		expect(screen.getByText(/No dependency manifest found/)).toBeInTheDocument();
	});

	it("needs a project", () => {
		render(<LicensePanel projectPath="" />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
	});
});

describe("CicdAnomalyPanel", () => {
	it("asks for a log first, then scans one build", async () => {
		api.analyseCicdLogs.mockResolvedValue({
			success: true,
			report: {
				signals: [
					{
						kind: "oom",
						severity: "critical",
						matching_line: "JavaScript heap out of memory",
						line_number: 3,
						suggested_fix: "Raise the heap.",
						log_label: "Build 1",
					},
					{
						kind: "brand_new_kind",
						severity: "low",
						matching_line: "odd",
						line_number: 9,
						suggested_fix: "Look at it.",
						fix_id: "fix_nobody_knows",
						log_label: "",
					},
				],
				recurring_kinds: [],
				summary: { samples: 1, total_signals: 2, by_kind: {}, by_severity: {} },
				fix_recommendations: [],
				recommendations: [{ kind: "oom", fix_id: "fix_nobody_knows", suggested_fix: "Raise the heap.", recurring: false }],
				has_critical: true,
			},
		});
		render(<CicdAnomalyPanel />);
		expect(screen.getByText("Paste a non-empty log")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Scan log" })).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Log content"), { target: { value: "boom" } });
		fireEvent.click(screen.getByRole("button", { name: "Scan log" }));
		expect(await screen.findByText("Detected signals (2)")).toBeInTheDocument();
		expect(api.analyseCicdLogs).toHaveBeenCalledWith([{ label: "Build 1", text: "boom" }]);
		expect(screen.getByText("critical")).toBeInTheDocument();
		expect(screen.getByText("brand_new_kind")).toBeInTheDocument();
		// One build: the line is said without the build's name.
		expect(screen.getByText("line 3")).toBeInTheDocument();
		expect(screen.getAllByText("Raise the heap.")).toHaveLength(2);
		expect(screen.getAllByText("Look at it.")).toHaveLength(1);
		expect(screen.queryByText("recurs")).not.toBeInTheDocument();
	});

	it("says when a log holds no known failure", async () => {
		api.analyseCicdLogs.mockResolvedValue({
			success: true,
			report: {
				signals: [],
				recurring_kinds: [],
				summary: { samples: 1, total_signals: 0, by_kind: {}, by_severity: {} },
				fix_recommendations: [],
				has_critical: false,
			},
		});
		render(<CicdAnomalyPanel />);
		fireEvent.change(screen.getByLabelText("Log content"), { target: { value: "all good" } });
		fireEvent.click(screen.getByRole("button", { name: "Scan log" }));
		expect(await screen.findByText("No known failure in this log.")).toBeInTheDocument();
	});

	it("takes up to five builds, and a build can be taken out again", async () => {
		render(<CicdAnomalyPanel />);
		const add = screen.getByRole("button", { name: "Add another build's log" });
		for (let i = 0; i < 4; i++) fireEvent.click(add);
		expect(add).toBeDisabled();
		expect(screen.getByLabelText("Build 5")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Build 2"), { target: { value: "second" } });
		fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
		await waitFor(() => expect(screen.getByLabelText("Build 1")).toHaveValue("second"));
		expect(screen.queryByLabelText("Build 5")).not.toBeInTheDocument();
		expect(add).toBeEnabled();
	});
});
