/**
 * @vitest-environment jsdom
 */
/** A task workpilot.policy.yaml paused (outside its hours, past a token budget, invalid) says so (#353). */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import type { PolicyPauseDetail, Task } from "../../../shared/types";
import { policyPause, TaskPolicyPause } from "./TaskPolicyPause";

function task(reason: string | undefined, policy?: PolicyPauseDetail, enabled = true): Task {
	return {
		id: "t1",
		metadata: { paused: { enabled, paused_at: null, paused_subtask_id: null, reason, policy } },
	} as unknown as Task;
}

describe("TaskPolicyPause", () => {
	it("shows nothing for another pause or a detail it cannot read", () => {
		const { container } = render(<TaskPolicyPause task={task("budget")} />);
		expect(container).toBeEmptyDOMElement();
		expect(policyPause(task("policy_hours"))).toBeNull();
		expect(policyPause(task("policy_hours", { reason: "policy_hours" }))).toBeNull();
		expect(policyPause(task("policy_budget", { reason: "policy_budget", tokensLastHour: 3 }))).toBeNull();
		expect(policyPause(task("policy_hours", { reason: "policy_hours", allowedHours: [] }, false))).toBeNull();
		expect(policyPause({ id: "t" } as unknown as Task)).toBeNull();
		expect(policyPause(task(undefined))).toBeNull();
		expect(policyPause(task("policy_budget", { reason: "policy_budget", tokensThisTask: 3 }))).toBeNull();
		expect(policyPause(task("policy_invalid", { reason: "policy_invalid" }))).toBeNull();
	});

	it("names the allowed hours", async () => {
		render(
			<TaskPolicyPause
				task={task("policy_hours", { reason: "policy_hours", timezone: "UTC", allowedHours: ["08:00-19:00"] })}
			/>,
		);
		fireEvent.click(screen.getByTestId("task-policy-pause"));
		expect(screen.getByText("Outside allowed hours")).toBeInTheDocument();
		expect(await screen.findByText(/08:00-19:00 \(UTC\)/)).toBeInTheDocument();
	});

	it("names the hours even without a time zone", async () => {
		render(<TaskPolicyPause task={task("policy_hours", { reason: "policy_hours", allowedHours: ["09:00-10:00"] })} />);
		fireEvent.click(screen.getByTestId("task-policy-pause"));
		expect(await screen.findByText(/09:00-10:00 \(\)/)).toBeInTheDocument();
	});

	it("names the tokens spent and the limit", async () => {
		render(
			<TaskPolicyPause
				task={task("policy_budget", { reason: "policy_budget", tokensLastHour: 1200, maxTokensPerHour: 1000 })}
			/>,
		);
		fireEvent.click(screen.getByTestId("task-policy-pause"));
		expect(screen.getByText("Token budget reached")).toBeInTheDocument();
		expect(await screen.findByText(/spent 1,200 tokens in the last hour/)).toBeInTheDocument();
	});

	it("names what the task spent against its own budget", async () => {
		render(
			<TaskPolicyPause
				task={task("policy_budget", { reason: "policy_budget", tokensThisTask: 5000, maxTokensPerTask: 4000 })}
			/>,
		);
		fireEvent.click(screen.getByTestId("task-policy-pause"));
		expect(screen.getByText("Task token budget reached")).toBeInTheDocument();
		expect(await screen.findByText(/This task's agents spent 5,000 tokens/)).toBeInTheDocument();
	});

	it("says the policy is invalid and how many errors it has", async () => {
		expect(policyPause(task("policy_invalid", { reason: "policy_invalid", errorCount: 0 }))).toEqual({
			kind: "invalid",
			count: 1,
		});
		render(<TaskPolicyPause task={task("policy_invalid", { reason: "policy_invalid", errorCount: 3 })} />);
		fireEvent.click(screen.getByTestId("task-policy-pause"));
		expect(screen.getByText("Invalid policy")).toBeInTheDocument();
		expect(await screen.findByText(/has 3 errors: no agent runs/)).toBeInTheDocument();
	});
});
