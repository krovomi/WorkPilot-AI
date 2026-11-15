/**
 * @vitest-environment jsdom
 */
/** A task the circuit breaker or the kill switch paused says so on its controls (#353). */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import type { BreakerPauseDetail, Task } from "../../../shared/types";
import { breakerPause, TaskBreakerPause } from "./TaskBreakerPause";

function task(reason: string | undefined, breaker?: BreakerPauseDetail): Task {
	return {
		id: "t1",
		metadata: { paused: { enabled: true, paused_at: null, paused_subtask_id: null, reason, breaker } },
	} as unknown as Task;
}

describe("TaskBreakerPause", () => {
	it("shows nothing for another pause", () => {
		const { container } = render(<TaskBreakerPause task={task(undefined)} />);
		expect(container).toBeEmptyDOMElement();
		expect(breakerPause(task("tool_loop"))).toBeNull(); // no detail, no claim
		expect(breakerPause(task("budget", { tool: "Read", repeats: 5, limit: 5 }))).toBeNull();
	});

	it("names the tool that repeated itself", async () => {
		render(<TaskBreakerPause task={task("tool_loop", { tool: "Bash", repeats: 5, limit: 5 })} />);
		fireEvent.click(screen.getByTestId("task-breaker-pause"));
		expect(screen.getByText("Circuit breaker: Bash")).toBeInTheDocument();
		expect(await screen.findByText(/called Bash 5 times/)).toBeInTheDocument();
	});

	it("says the kill switch stopped it", () => {
		render(<TaskBreakerPause task={task("kill_switch")} />);
		expect(screen.getByTestId("task-kill-switch-pause")).toHaveTextContent("Stopped by Stop all agents");
	});
});
