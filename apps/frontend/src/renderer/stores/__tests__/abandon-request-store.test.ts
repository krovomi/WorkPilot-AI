import { describe, expect, it } from "vitest";
import { useAbandonRequestStore } from "../abandon-request-store";

describe("useAbandonRequestStore", () => {
	it("holds the asked ids once each, until closed", () => {
		useAbandonRequestStore.getState().request(["a", "b", "a"]);
		expect(useAbandonRequestStore.getState().ids).toEqual(["a", "b"]);
		useAbandonRequestStore.getState().close();
		expect(useAbandonRequestStore.getState().ids).toEqual([]);
	});
});
