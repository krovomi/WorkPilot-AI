import { describe, expect, it } from "vitest";
import { BLOCK_CATEGORIES } from "./architecture-blocks";
import { canConnect } from "./architecture-connections";
import { connectionVerdict, isUnexplained } from "./connection-verdicts";

const TYPES = BLOCK_CATEGORIES.flatMap((c) => c.blocks)
	.map((b) => b.type)
	.filter((t) => t !== "custom");
const names = { source: "A", target: "B" };

describe("connectionVerdict", () => {
	it("decides every pair of the palette: a known edge or a reason of its own", () => {
		// 19 typed blocks, 361 ordered pairs: none may fall back to the bare
		// "the rules do not foresee this link".
		const unexplained: string[] = [];
		for (const s of TYPES) {
			for (const t of TYPES) {
				if (isUnexplained(s, t)) unexplained.push(`${s} → ${t}`);
			}
		}
		expect(unexplained).toEqual([]);
	});

	it("accepts what canConnect accepts", () => {
		expect(connectionVerdict("backend", "worker", names, "fr")).toEqual({ ok: true });
	});

	it("spots an arrow drawn backwards and says which way it goes", () => {
		const v = connectionVerdict("database", "backend", { source: "Orders DB", target: "API" }, "fr");
		expect(v.ok).toBe(false);
		expect(v.reversed).toBe(true);
		expect(v.reason).toContain("API lit et écrit ses données dans Orders DB");
	});

	it("keeps clients away from data stores and points to the layer in between", () => {
		const v = connectionVerdict("frontend", "database", names, "fr", (k) =>
			k === "database" ? "Base de données" : k,
		);
		expect(v.reversed).toBeFalsy();
		expect(v.reason).toContain("« Base de données »");
		expect(v.via).toEqual(["backend", "gateway"]);
	});

	it("sends a client's background work through the backend", () => {
		expect(connectionVerdict("frontend", "worker", names, "en").via).toEqual([
			"backend",
			"queue",
		]);
	});

	it("keeps services off the gateway", () => {
		const v = connectionVerdict("worker", "gateway", names, "en");
		expect(v.reason).toMatch(/way in/);
	});

	it("is permissive for free and custom blocks", () => {
		expect(connectionVerdict("custom", "database", names, "fr").ok).toBe(true);
		expect(connectionVerdict(undefined, "queue", names, "fr").ok).toBe(true);
	});

	it("never calls a known edge backwards", () => {
		for (const s of TYPES) {
			for (const t of TYPES) {
				const v = connectionVerdict(s, t, names, "en");
				if (v.reversed) expect(canConnect(t, s), `${s} → ${t}`).toBe(true);
			}
		}
	});
});
