/**
 * The carbon budget alerts (#365), sent without anyone opening the page.
 *
 * A few minutes after the app starts, then every hour, each project with a
 * `.workpilot/carbon.json` asks the runner which thresholds of its monthly
 * budget were crossed and not announced yet (the runner remembers them per
 * month). Each one is announced on the desktop and on the person's ntfy or
 * Telegram channel. A project without the file costs no process.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import type { CarbonConfigInput } from "../../shared/types/carbon-profiler";

const FIRST_CHECK_MS = 4 * 60_000;
const EVERY_MS = 60 * 60_000;
const REGION = /^[a-z][a-z-]{1,20}$/;
const FACTOR =
	/^(grid\.[a-z-]{2,20}|pue\.[a-z.-]{1,30}|wh_per_1k_output\.(small|medium|large)|region\.[a-z.-]{1,30})$/;

export interface BudgetCheck {
	alerts: number[];
	budget: { month: string; usedG: number; budgetG: number; percent: number | null; degraded: boolean } | null;
}

function number(value: unknown, low: number, high: number): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : null;
}

/** Settings the renderer asks to save, or null when they are not of the known shape. */
export function readCarbonConfig(raw: unknown): CarbonConfigInput | null {
	const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!c || typeof c.region !== "string" || !REGION.test(c.region)) return null;
	const budget = number(c.monthlyBudgetKg, 0, 1_000_000);
	const alert = number(c.alertPercent, 10, 99);
	const power = number(c.localPowerW, 1, 5000);
	if (budget === null || alert === null || power === null) return null;
	const factors: Record<string, number | string> = {};
	if (c.factors && typeof c.factors === "object") {
		for (const [key, value] of Object.entries(c.factors as Record<string, unknown>).slice(0, 60)) {
			if (!FACTOR.test(key)) continue;
			if (key.startsWith("region.") ? typeof value === "string" && REGION.test(value) : number(value, 0.000001, 4999) !== null) {
				factors[key] = value as number | string;
			}
		}
	}
	return {
		region: c.region,
		monthlyBudgetKg: budget,
		alertPercent: Math.round(alert),
		degrade: c.degrade === true,
		localPowerW: power,
		cpuOnly: c.cpuOnly === true,
		factors,
	};
}

/** Whether the project has carbon settings worth a check (a plain file, no link on the way). */
export function hasCarbonSettings(projectRoot: string): boolean {
	try {
		const folder = lstatSync(path.join(projectRoot, ".workpilot"));
		const file = lstatSync(path.join(projectRoot, ".workpilot", "carbon.json"));
		return folder.isDirectory() && !folder.isSymbolicLink() && file.isFile() && !file.isSymbolicLink();
	} catch {
		return false;
	}
}

export function readBudgetCheck(result: unknown): BudgetCheck {
	const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
	const alerts = Array.isArray(r.alerts)
		? r.alerts.filter((a): a is number => typeof a === "number" && a >= 10 && a <= 100).slice(0, 2)
		: [];
	const b = r.budget && typeof r.budget === "object" ? (r.budget as Record<string, unknown>) : null;
	return {
		alerts,
		budget: b
			? {
					month: typeof b.month === "string" ? b.month.slice(0, 7) : "",
					usedG: typeof b.usedG === "number" ? b.usedG : 0,
					budgetG: typeof b.budgetG === "number" ? b.budgetG : 0,
					percent: typeof b.percent === "number" ? b.percent : null,
					degraded: b.degraded === true,
				}
			: null,
	};
}

const kg = (grams: number, language: string) =>
	(grams / 1000).toLocaleString(language === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 2 });

export function alertText(
	language: string,
	project: string,
	threshold: number,
	budget: NonNullable<BudgetCheck["budget"]>,
): { title: string; body: string } {
	const used = kg(budget.usedG, language);
	const total = kg(budget.budgetG, language);
	if (language === "fr") {
		return {
			title: `Budget carbone : ${project}`,
			body:
				threshold >= 100
					? `Le budget carbone de ${budget.month} est atteint : ${used} kg CO₂e estimés sur ${total} kg.` +
						(budget.degraded ? " Les modèles les plus lourds passent au modèle standard de leur fournisseur." : "")
					: `${threshold} % du budget carbone de ${budget.month} est utilisé : ${used} kg CO₂e estimés sur ${total} kg.`,
		};
	}
	return {
		title: `Carbon budget: ${project}`,
		body:
			threshold >= 100
				? `The carbon budget of ${budget.month} is reached: an estimated ${used} kg CO₂e of ${total} kg.` +
					(budget.degraded ? " Flagship models now run on their provider's standard model." : "")
				: `${threshold}% of the carbon budget of ${budget.month} is used: an estimated ${used} kg CO₂e of ${total} kg.`,
	};
}

export interface BudgetDeps {
	projects: () => { id: string; name: string; path: string }[];
	resolve: (projectPath: string) => string | null;
	run: (projectRoot: string) => Promise<unknown>;
	announce: (projectId: string, text: { title: string; body: string }) => void;
	language: () => string;
}

/** One pass over the projects, one at a time. Never throws. */
export async function checkBudgets(deps: BudgetDeps): Promise<number> {
	let sent = 0;
	for (const project of deps.projects()) {
		const root = deps.resolve(project.path);
		if (!root || !hasCarbonSettings(root)) continue;
		try {
			const check = readBudgetCheck(await deps.run(root));
			if (!check.budget) continue;
			const highest = Math.max(...check.alerts, 0);
			if (highest > 0) {
				deps.announce(project.id, alertText(deps.language(), project.name, highest, check.budget));
				sent += 1;
			}
		} catch (err) {
			console.warn(`[CarbonProfiler] The budget check of ${project.name} failed:`, err);
		}
	}
	return sent;
}

export function startCarbonBudgetChecks(deps: BudgetDeps): () => void {
	let running = false;
	const tick = () => {
		if (running) return;
		running = true;
		void checkBudgets(deps).finally(() => {
			running = false;
		});
	};
	const first = setTimeout(tick, FIRST_CHECK_MS);
	const every = setInterval(tick, EVERY_MS);
	first.unref?.();
	every.unref?.();
	return () => {
		clearTimeout(first);
		clearInterval(every);
	};
}
