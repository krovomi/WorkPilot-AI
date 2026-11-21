/**
 * What a project has earned, kept per project and announced once.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { usePixelOfficeAchievementsStore } from "../pixel-office-achievements-store";

const store = () => usePixelOfficeAchievementsStore.getState();
const AT = new Date("2026-11-16T10:00:00Z");
const LATER = new Date("2026-11-17T10:00:00Z");

describe("pixel office achievements store", () => {
	beforeEach(() => {
		localStorage.clear();
		usePixelOfficeAchievementsStore.setState({ unlocked: {} });
	});

	it("records a project's first evaluation silently, then announces what is new", () => {
		expect(store().record("p", ["first-ship"], AT)).toEqual([]);
		expect(store().unlocked.p).toEqual({ "first-ship": AT.toISOString() });

		expect(store().record("p", ["first-ship", "qa-first-try"], LATER)).toEqual([
			"qa-first-try",
		]);
		expect(store().unlocked.p).toEqual({
			"first-ship": AT.toISOString(),
			"qa-first-try": LATER.toISOString(),
		});
	});

	it("keeps each project apart, and changes nothing when nothing is new", () => {
		store().record("p", [], AT);
		expect(store().unlocked.p).toEqual({});
		const before = store().unlocked;
		expect(store().record("p", [], LATER)).toEqual([]);
		expect(store().unlocked).toBe(before);

		store().record("q", ["second-opinion"], AT);
		expect(Object.keys(store().unlocked)).toEqual(["p", "q"]);
	});

	it("persists the unlocked map and drops malformed entries on reload", async () => {
		store().record("p", ["first-ship"], AT);
		const saved = JSON.parse(localStorage.getItem("pixel-office-achievements") ?? "{}");
		expect(saved.state).toEqual({ unlocked: { p: { "first-ship": AT.toISOString() } } });

		localStorage.setItem(
			"pixel-office-achievements",
			JSON.stringify({
				state: {
					unlocked: {
						p: { "first-ship": "2026-11-01", "made-up": "x", "qa-first-try": 3 },
						q: "garbage",
						r: null,
					},
				},
				version: 0,
			}),
		);
		await usePixelOfficeAchievementsStore.persist.rehydrate();
		expect(store().unlocked).toEqual({ p: { "first-ship": "2026-11-01" } });

		for (const state of [null, { unlocked: "x" }]) {
			localStorage.setItem(
				"pixel-office-achievements",
				JSON.stringify({ state, version: 0 }),
			);
			await usePixelOfficeAchievementsStore.persist.rehydrate();
			expect(store().unlocked).toEqual({});
		}
	});
});
