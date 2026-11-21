import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../__tests__/helpers/renderer-api";
import { DEFERRED_DELETE_MS, deleteLater, usePendingDeleteStore } from "../pending-delete-store";
import { useTaskStore } from "../task-store";

let api: RendererApi;

beforeEach(() => {
	vi.useFakeTimers();
	usePendingDeleteStore.setState({ ids: new Set() });
	useTaskStore.setState({ tasks: [] });
	api = installRendererApi({ deleteTask: vi.fn(async () => ({ success: true })) });
});

afterEach(() => {
	vi.useRealTimers();
	api.restore();
});

const hidden = () => [...usePendingDeleteStore.getState().ids];

describe("deleteLater", () => {
	it("hides the cards, then deletes them after the delay", async () => {
		const onFailed = vi.fn();
		const pending = deleteLater(["a", "b"], onFailed);
		expect(hidden()).toEqual(["a", "b"]);
		await vi.advanceTimersByTimeAsync(DEFERRED_DELETE_MS - 1);
		expect(api.fn("deleteTask")).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(api.fn("deleteTask")).toHaveBeenCalledTimes(2);
		expect(hidden()).toEqual([]);
		expect(onFailed).not.toHaveBeenCalled();
		expect(pending.cancel()).toBe(false);
	});

	it("brings the cards back when cancelled in time", async () => {
		const pending = deleteLater(["a"], vi.fn());
		expect(pending.cancel()).toBe(true);
		expect(hidden()).toEqual([]);
		await vi.advanceTimersByTimeAsync(DEFERRED_DELETE_MS);
		expect(api.fn("deleteTask")).not.toHaveBeenCalled();
		expect(pending.cancel()).toBe(false);
	});

	it("shows a card it could not delete again, and says so", async () => {
		api.restore();
		api = installRendererApi({
			deleteTask: vi.fn(async () => ({ success: false, error: "locked" })),
		});
		const onFailed = vi.fn();
		deleteLater(["a"], onFailed);
		await vi.advanceTimersByTimeAsync(DEFERRED_DELETE_MS);
		expect(hidden()).toEqual([]);
		expect(onFailed).toHaveBeenCalledWith(expect.any(String));
	});
});
