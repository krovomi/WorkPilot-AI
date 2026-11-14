/**
 * Two views watch one task's log; closing one must not silence the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskLogWatchesForTests, retainTaskLogWatch } from "../task-log-watch";

const watchTaskLogs = vi.fn(async () => ({ success: true }));
const unwatchTaskLogs = vi.fn(async () => ({ success: true }));

beforeEach(() => {
	(globalThis as unknown as { window: unknown }).window = {
		electronAPI: { watchTaskLogs, unwatchTaskLogs },
	};
});

afterEach(() => {
	resetTaskLogWatchesForTests();
	vi.clearAllMocks();
});

describe("retainTaskLogWatch", () => {
	it("watches once and stops only when the last holder lets go", () => {
		const panel = retainTaskLogWatch("p1", "001-a");
		const bubble = retainTaskLogWatch("p1", "001-a");
		expect(watchTaskLogs).toHaveBeenCalledTimes(1);
		expect(watchTaskLogs).toHaveBeenCalledWith("p1", "001-a");

		bubble();
		expect(unwatchTaskLogs).not.toHaveBeenCalled();
		bubble(); // a second release of the same hold counts once
		expect(unwatchTaskLogs).not.toHaveBeenCalled();

		panel();
		expect(unwatchTaskLogs).toHaveBeenCalledWith("001-a");
		expect(unwatchTaskLogs).toHaveBeenCalledTimes(1);
	});

	it("watches again after everyone let go", () => {
		retainTaskLogWatch("p1", "001-a")();
		retainTaskLogWatch("p1", "001-a");
		expect(watchTaskLogs).toHaveBeenCalledTimes(2);
	});

	it("survives a bridge that throws or answers nothing", () => {
		watchTaskLogs.mockImplementationOnce(() => {
			throw new Error("gone");
		});
		unwatchTaskLogs.mockImplementationOnce(
			() => undefined as unknown as Promise<{ success: boolean }>,
		);
		expect(() => retainTaskLogWatch("p1", "002-b")()).not.toThrow();
	});
});
