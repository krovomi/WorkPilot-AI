/**
 * Lot C of the suite placement: the project switch (automatic / manual), the
 * card's own choice, the card's badge and the merge held while the CI runs.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CiSuiteRecord, ProjectSettings, SuitePlacement, Task, TestPlacementMode } from "../../../../shared/types";
import { SuiteHoldNotice } from "../../task-detail/task-review/SuiteHoldNotice";
import { ProjectTestPlacementSettings } from "../ProjectTestPlacementSettings";
import { SuitePlacementBadge, shownSuiteState } from "../SuitePlacementBadge";
import { isHeldBySuite, placementModeOf } from "../suite-hold";
import { TestPlacementFields } from "../TestPlacementFields";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "target" in options ? `${key}:${String(options.target)}` : key,
		i18n: { language: "en" },
	}),
}));

const SHA = "a".repeat(40);

function suite(state: CiSuiteRecord["state"], extra: Partial<CiSuiteRecord> = {}): CiSuiteRecord {
	return { state, branch: "workpilot/001-x", sha: SHA, pushedAt: "2026-11-22T10:00:00Z", ...extra };
}

function placement(target: SuitePlacement["target"], reason = "branch_push"): SuitePlacement {
	return { target, reason, mode: "auto", short: ["cpu"], facts: {} };
}

function ProjectHarness({ initial }: { readonly initial: ProjectSettings }) {
	const [settings, setSettings] = useState(initial);
	return (
		<>
			<ProjectTestPlacementSettings
				settings={settings}
				onChange={(patch) => setSettings((previous) => ({ ...previous, ...patch }))}
			/>
			<output data-testid="state">{JSON.stringify({
				mode: settings.testPlacement ?? null,
				push: settings.testPlacementBranchPush ?? null,
			})}</output>
		</>
	);
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");

describe("project switch", () => {
	it("is automatic by default and offers the branch push, on by default", () => {
		render(<ProjectHarness initial={{} as ProjectSettings} />);
		expect(screen.getByRole("switch", { name: "tasks:suitePlacement.project.label" })).toHaveAttribute("aria-checked", "true");
		const push = screen.getByRole("switch", { name: "tasks:suitePlacement.project.branchPush" });
		expect(push).toHaveAttribute("aria-checked", "true");
		fireEvent.click(push);
		expect(state()).toEqual({ mode: null, push: false });
	});

	it("goes manual on this machine, then lets the person pick the CI", () => {
		render(<ProjectHarness initial={{} as ProjectSettings} />);
		fireEvent.click(screen.getByRole("switch", { name: "tasks:suitePlacement.project.label" }));
		expect(state().mode).toBe("machine");
		expect(screen.queryByRole("switch", { name: "tasks:suitePlacement.project.branchPush" })).toBeNull();
		fireEvent.click(screen.getByRole("radio", { name: "tasks:suitePlacement.modes.ci" }));
		expect(state().mode).toBe("ci");
		fireEvent.click(screen.getByRole("switch", { name: "tasks:suitePlacement.project.label" }));
		expect(state().mode).toBe("auto");
	});
});

describe("card's own choice", () => {
	function FieldHarness() {
		const [value, setValue] = useState<TestPlacementMode | undefined>("ci");
		return (
			<>
				<TestPlacementFields value={value} onChange={setValue} />
				<output data-testid="value">{value ?? "project"}</output>
			</>
		);
	}

	it("keeps the project's choice by default and maps the options", () => {
		render(<FieldHarness />);
		const select = screen.getByLabelText("tasks:suitePlacement.form.label");
		expect(select).toHaveValue("ci");
		fireEvent.change(select, { target: { value: "project" } });
		expect(screen.getByTestId("value")).toHaveTextContent("project");
		fireEvent.change(select, { target: { value: "machine" } });
		expect(screen.getByTestId("value")).toHaveTextContent("machine");
	});

	it("reads only the three known modes", () => {
		expect(placementModeOf("auto")).toBe("auto");
		expect(placementModeOf("cloud")).toBeUndefined();
		expect(placementModeOf(undefined)).toBeUndefined();
	});
});

describe("card badge", () => {
	it("says nothing when the suite simply ran here", () => {
		expect(shownSuiteState({})).toBeNull();
		expect(shownSuiteState({ suitePlacement: placement("machine", "room") })).toBeNull();
	});

	it("follows the queue, the route, then the CI's verdict", () => {
		expect(shownSuiteState({ suitePlacement: placement("queue", "no_route") })).toBe("queued");
		expect(shownSuiteState({ suitePlacement: placement("server", "server") })).toBe("sent");
		expect(shownSuiteState({ suitePlacement: placement("ci"), ciSuite: suite("pending") })).toBe("pending");
		expect(shownSuiteState({ ciSuite: suite("failed") })).toBe("failed");
	});

	it("names the target and gives the reasons on hover", () => {
		const task = {
			suitePlacement: placement("ci"),
			ciSuite: suite("not_started", { sha: "", reason: "no_pipeline" }),
		} as Task;
		render(<SuitePlacementBadge task={task} />);
		const badge = screen.getByText("tasks:suitePlacement.badge.not_started:tasks:suitePlacement.targets.ci");
		expect(badge.getAttribute("title")).toBe(
			"tasks:suitePlacement.reasons.branch_push\ntasks:suitePlacement.notStarted.no_pipeline",
		);
	});
});

describe("merge hold", () => {
	it("holds only while the CI suite is pending", () => {
		expect(isHeldBySuite({ ciSuite: suite("pending") })).toBe(true);
		for (const done of ["passed", "failed", "not_started"] as const) {
			expect(isHeldBySuite({ ciSuite: suite(done) })).toBe(false);
		}
		expect(isHeldBySuite({})).toBe(false);
	});

	it("opens the run from the notice", () => {
		const openExternal = vi.fn().mockResolvedValue(undefined);
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = { openExternal };
		render(<SuiteHoldNotice webUrl="https://ci.example.test/run/1" />);
		expect(screen.getByRole("status")).toHaveTextContent("tasks:suitePlacement.mergeHeld");
		fireEvent.click(screen.getByRole("button", { name: /mergeHeldLink/ }));
		expect(openExternal).toHaveBeenCalledWith("https://ci.example.test/run/1");
	});

	it("has no link without a run", () => {
		render(<SuiteHoldNotice />);
		expect(screen.queryByRole("button")).toBeNull();
	});
});
