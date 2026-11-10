import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertText, checkBudgets, hasCarbonSettings, readBudgetCheck, readCarbonConfig } from "../budget-alerts";

const folders: string[] = [];
function project(withSettings = true): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "carbon-alerts-"));
	folders.push(root);
	if (withSettings) {
		mkdirSync(path.join(root, ".workpilot"));
		writeFileSync(path.join(root, ".workpilot", "carbon.json"), "{}", "utf-8");
	}
	return root;
}

afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const budget = { month: "2026-11", usedG: 4200, budgetG: 5000, percent: 84, degraded: false };

describe("readCarbonConfig", () => {
	it("keeps settings of the known shape", () => {
		expect(
			readCarbonConfig({
				region: "fr",
				monthlyBudgetKg: 5,
				alertPercent: 80.4,
				degrade: true,
				localPowerW: 150,
				cpuOnly: "yes",
				factors: { "grid.fr": 32, "region.mistral": "fr", "rm -rf": 1, "pue.x": "1.2" },
			}),
		).toEqual({
			region: "fr",
			monthlyBudgetKg: 5,
			alertPercent: 80,
			degrade: true,
			localPowerW: 150,
			cpuOnly: false,
			factors: { "grid.fr": 32, "region.mistral": "fr" },
		});
	});

	it("refuses a value out of range or of the wrong type", () => {
		const good = { region: "fr", monthlyBudgetKg: 5, alertPercent: 80, localPowerW: 150 };
		expect(readCarbonConfig({ ...good, region: "../x" })).toBeNull();
		expect(readCarbonConfig({ ...good, monthlyBudgetKg: -1 })).toBeNull();
		expect(readCarbonConfig({ ...good, alertPercent: 100 })).toBeNull();
		expect(readCarbonConfig({ ...good, localPowerW: "150" })).toBeNull();
		expect(readCarbonConfig(null)).toBeNull();
	});
});

describe("hasCarbonSettings", () => {
	it("needs a plain carbon.json, never a link", () => {
		expect(hasCarbonSettings(project())).toBe(true);
		expect(hasCarbonSettings(project(false))).toBe(false);
		const root = project(false);
		const elsewhere = project();
		symlinkSync(path.join(elsewhere, ".workpilot"), path.join(root, ".workpilot"));
		expect(hasCarbonSettings(root)).toBe(false);
	});
});

describe("alertText", () => {
	it("words the threshold in the app's language", () => {
		expect(alertText("en", "Shop", 80, budget).body).toBe(
			"80% of the carbon budget of 2026-11 is used: an estimated 4.2 kg CO₂e of 5 kg.",
		);
		const fr = alertText("fr", "Shop", 100, { ...budget, degraded: true });
		expect(fr.title).toBe("Budget carbone : Shop");
		expect(fr.body).toContain("est atteint : 4,2 kg CO₂e estimés sur 5 kg.");
		expect(fr.body).toContain("modèle standard");
	});
});

describe("checkBudgets", () => {
	const deps = (root: string, result: unknown) => ({
		projects: () => [{ id: "p1", name: "Shop", path: root }],
		resolve: (p: string) => p,
		run: vi.fn(async () => result),
		announce: vi.fn(),
		language: () => "en",
	});

	it("announces only the highest threshold newly crossed", async () => {
		const d = deps(project(), { alerts: [80, 100], budget: { ...budget, usedG: 6000, percent: 120 } });
		expect(await checkBudgets(d)).toBe(1);
		expect(d.announce).toHaveBeenCalledTimes(1);
		expect(d.announce.mock.calls[0][1].body).toContain("is reached");
	});

	it("skips a project without settings and never throws", async () => {
		const none = deps(project(false), { alerts: [80], budget });
		expect(await checkBudgets(none)).toBe(0);
		expect(none.run).not.toHaveBeenCalled();

		const failing = deps(project(), null);
		failing.run.mockRejectedValueOnce(new Error("boom"));
		expect(await checkBudgets(failing)).toBe(0);
	});

	it("reads a runner result defensively", () => {
		expect(readBudgetCheck({ alerts: [80, "x", 500], budget: null })).toEqual({ alerts: [80], budget: null });
	});
});
