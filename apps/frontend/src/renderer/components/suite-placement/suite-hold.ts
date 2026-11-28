import type { Task, TestPlacementMode } from "../../../shared/types";
import { TEST_PLACEMENT_MODES } from "../../../shared/types";

/**
 * The merge waits while the task's full suite runs on the forge's CI: the
 * card reached human review on the change's own tests, and the whole suite's
 * verdict is still to come. A red verdict moves the card to « Build rouge »;
 * a suite that never started does not hold the merge (the card says so).
 */
export function isHeldBySuite(task: Pick<Task, "ciSuite">): boolean {
	return task.ciSuite?.state === "pending";
}

/** A stored value, or `undefined` (the project's choice) when it is none of ours. */
export function placementModeOf(value: unknown): TestPlacementMode | undefined {
	return TEST_PLACEMENT_MODES.find((mode) => mode === value);
}
