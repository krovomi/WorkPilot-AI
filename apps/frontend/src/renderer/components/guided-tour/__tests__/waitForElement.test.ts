/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForElement } from "../waitForElement";

function add(id: string) {
	const el = document.createElement("div");
	el.id = id;
	document.body.appendChild(el);
	return el;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe("waitForElement", () => {
	it("returns an element already in the page at once", async () => {
		const el = add("here");
		await expect(waitForElement("#here")).resolves.toBe(el);
	});

	it("waits for an element that mounts later", async () => {
		const pending = waitForElement("#later", 500);
		await vi.advanceTimersByTimeAsync(100);
		const el = add("later");
		await vi.advanceTimersByTimeAsync(20);
		await expect(pending).resolves.toBe(el);
	});

	it("gives up after its timeout", async () => {
		const pending = waitForElement("#never", 200);
		await vi.advanceTimersByTimeAsync(250);
		await expect(pending).resolves.toBeNull();
		// No frame is left polling.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops as soon as it is aborted", async () => {
		const controller = new AbortController();
		const pending = waitForElement("#never", 5000, controller.signal);
		await vi.advanceTimersByTimeAsync(50);
		controller.abort();
		await expect(pending).resolves.toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves at once with a signal aborted before the call", async () => {
		const controller = new AbortController();
		controller.abort();
		add("here");
		await expect(waitForElement("#here", 5000, controller.signal)).resolves.toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps no abort listener once it found or gave up", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const found = waitForElement("#later", 500, controller.signal);
		add("later");
		await vi.advanceTimersByTimeAsync(20);
		await found;
		const missed = waitForElement("#never", 100, controller.signal);
		await vi.advanceTimersByTimeAsync(150);
		await missed;
		expect(remove).toHaveBeenCalledTimes(2);
	});
});
