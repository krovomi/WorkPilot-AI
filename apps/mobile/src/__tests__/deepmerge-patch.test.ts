// GHSA-gcqx-w48m-w2h4 / CVE-2026-93753: deepmerge <= 4.3.1 let an own
// `__proto__` key replace the merged object's prototype. Jest's config loader
// is the only consumer here, and pnpm-workspace.yaml points it at the patched
// copy in vendor/deepmerge. These tests fail if the override is dropped while
// the upstream package is still unfixed.
import deepmerge from "deepmerge";
// The hoisted linker leaves one deepmerge in node_modules, the one jest-config loads.
import manifest from "deepmerge/package.json";

type Flagged = { isAdmin?: boolean };

const poisoned = (): Record<string, unknown> => JSON.parse('{"__proto__": {"isAdmin": true}}');

describe("patched deepmerge", () => {
	it("is the vendored copy that jest-config resolves", () => {
		expect(manifest.name).toBe("@workpilot/deepmerge-patched");
	});

	it("does not let __proto__ through into a null-prototype target", () => {
		const merged = deepmerge(Object.create(null), poisoned()) as Flagged;
		expect(merged.isAdmin).toBeUndefined();
		expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
	});

	it("does not let __proto__ through when the target has its own __proto__ key", () => {
		const target = {};
		Object.defineProperty(target, "__proto__", { value: {}, enumerable: true, writable: true, configurable: true });
		const merged = deepmerge(target, poisoned()) as Flagged;
		expect(merged.isAdmin).toBeUndefined();
		expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
	});

	it("never copies __proto__ out of the target either", () => {
		const merged = deepmerge(poisoned(), { a: 1 }) as Flagged & { a: number };
		expect(merged.isAdmin).toBeUndefined();
		expect(merged.a).toBe(1);
	});

	it("keeps the 4.3.1 behaviour jest relies on", () => {
		expect(deepmerge({ a: { b: 1 }, list: [1] }, { a: { c: 2 }, list: [2] })).toEqual({
			a: { b: 1, c: 2 },
			list: [1, 2],
		});
		expect(deepmerge.all([{ a: 1 }, { b: 2 }, { a: 3 }])).toEqual({ a: 3, b: 2 });
		expect(deepmerge({ list: [1] }, { list: [2] }, { arrayMerge: (_t, s) => s })).toEqual({ list: [2] });
		const source = { nested: { x: 1 } };
		expect(deepmerge({}, source).nested).not.toBe(source.nested);
		expect(deepmerge({}, source, { clone: false }).nested).toBe(source.nested);
	});
});
