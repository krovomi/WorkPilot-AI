import { afterEach, describe, expect, it } from "vitest";
import { CACHE_DURATION_MS, readCachedItems, writeCachedItems } from "../panel-storage";

const KEY = "work-item-panel-test";

afterEach(() => localStorage.clear());

describe("readCachedItems", () => {
	it("gives back a list saved less than five minutes ago", () => {
		writeCachedItems(KEY, [{ id: 1 }], 1_000);
		expect(readCachedItems(KEY, 1_000 + CACHE_DURATION_MS - 1)).toEqual({ items: [{ id: 1 }], time: 1_000 });
	});

	it("reads an older list as nothing saved", () => {
		writeCachedItems(KEY, [{ id: 1 }], 1_000);
		expect(readCachedItems(KEY, 1_000 + CACHE_DURATION_MS)).toBeNull();
	});

	it("reads a saved value that is not a list as nothing saved", () => {
		localStorage.setItem(KEY, JSON.stringify({ id: 1 }));
		localStorage.setItem(`${KEY}-time`, "1000");
		expect(readCachedItems(KEY, 1_001)).toBeNull();
	});

	it("reads a time saved without its list as nothing saved", () => {
		localStorage.setItem(`${KEY}-time`, "1000");
		expect(readCachedItems(KEY, 1_001)).toBeNull();
	});

	it("reads a value that is not JSON as nothing saved", () => {
		localStorage.setItem(KEY, "{not json");
		localStorage.setItem(`${KEY}-time`, "1000");
		expect(readCachedItems(KEY, 1_001)).toBeNull();
	});
});
