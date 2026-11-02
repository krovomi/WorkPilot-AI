import { describe, expect, it, vi } from "vitest";
import { coalesceInFlight } from "../coalesce-in-flight";

describe("coalesceInFlight", () => {
	it("shares one run between callers while it is in flight", async () => {
		let release: (value: number) => void = () => undefined;
		const run = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					release = resolve;
				}),
		);
		const check = coalesceInFlight(run);

		const first = check();
		const second = check();
		release(42);

		await expect(first).resolves.toBe(42);
		await expect(second).resolves.toBe(42);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh run once the previous one settled, even after a failure", async () => {
		const run = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce("ok");
		const check = coalesceInFlight(run);

		await expect(check()).rejects.toThrow("offline");
		await expect(check()).resolves.toBe("ok");
		expect(run).toHaveBeenCalledTimes(2);
	});
});
