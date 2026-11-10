/**
 * The monthly compliance report, made without anyone asking (#357).
 *
 * A few minutes after the app starts, then every six hours, each project
 * whose `.workpilot/compliance/config.json` asks for it gets the report of
 * the month just ended, when it is not saved yet (so: on the 1st, or at the
 * first start after it). A control without evidence for more than 30 days is
 * announced on the desktop and on the person's ntfy or Telegram channel.
 *
 * The config is only read here (no link followed, size capped); the runner
 * makes and saves the report, and never rewrites one already saved.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

const FIRST_CHECK_MS = 3 * 60_000;
const EVERY_MS = 6 * 60 * 60_000;
const MAX_CONFIG_BYTES = 16 * 1024;
export const FRAMEWORK_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface MonthlyConfig {
	frameworks: string[];
	monthly: boolean;
}

export interface MadeReport {
	name: string;
	framework: { id: string; name: string };
	period: string;
	coveragePercent: number;
	alerts: { controlId: string }[];
}

/** `2026-12-01` -> `2026-11` (UTC). */
export function previousMonth(now: Date): string {
	const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
	const last = new Date(first - 1);
	return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}`;
}

function regularFile(file: string): boolean {
	try {
		const stat = lstatSync(file);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function folder(projectRoot: string, ...parts: string[]): string | null {
	let current = projectRoot;
	for (const part of [".workpilot", "compliance", ...parts]) {
		current = path.join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) return null;
		} catch {
			return null;
		}
	}
	return current;
}

/** A config the renderer asks to save, or null when it is not of the known shape. */
export function readConfig(raw: unknown): MonthlyConfig | null {
	const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!c || !Array.isArray(c.frameworks) || c.frameworks.length > 20) return null;
	if (!c.frameworks.every((f) => typeof f === "string" && FRAMEWORK_ID.test(f))) return null;
	return { frameworks: c.frameworks as string[], monthly: c.monthly === true };
}

/**
 * The text of a plain file, checked on the descriptor itself so nothing can
 * swap it between the check and the read. O_NOFOLLOW refuses a link where it
 * exists; Windows has none, so the name must still be the file opened.
 */
function readPlainFile(file: string, maxBytes: number): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(fd);
		const named = lstatSync(file);
		if (!stat.isFile() || !named.isFile() || named.ino !== stat.ino || named.dev !== stat.dev) return null;
		if (stat.size > maxBytes) return null;
		const buffer = Buffer.alloc(stat.size);
		const read = readSync(fd, buffer, 0, stat.size, 0);
		return buffer.subarray(0, read).toString("utf-8");
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export function readMonthlyConfig(projectRoot: string): MonthlyConfig | null {
	const base = folder(projectRoot);
	if (!base) return null;
	const text = readPlainFile(path.join(base, "config.json"), MAX_CONFIG_BYTES);
	if (text === null) return null;
	try {
		const data = JSON.parse(text) as Record<string, unknown>;
		const frameworks = Array.isArray(data.frameworks)
			? data.frameworks.filter((f): f is string => typeof f === "string" && FRAMEWORK_ID.test(f))
			: [];
		return { frameworks: frameworks.slice(0, 20), monthly: data.monthly === true };
	} catch {
		return null;
	}
}

/** Whether a report of the month just ended is missing for a framework chosen. */
export function monthlyDue(projectRoot: string, now: Date): boolean {
	const config = readMonthlyConfig(projectRoot);
	if (!config?.monthly || config.frameworks.length === 0) return false;
	const month = previousMonth(now);
	const reports = folder(projectRoot, "reports");
	return config.frameworks.some((id) => !reports || !regularFile(path.join(reports, `${id}-${month}.json`)));
}

export function readMade(result: unknown): MadeReport[] {
	const made = (result as { made?: unknown } | null)?.made;
	if (!Array.isArray(made)) return [];
	return made.slice(0, 20).flatMap((item) => {
		const m = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const framework = m.framework && typeof m.framework === "object" ? (m.framework as Record<string, unknown>) : {};
		if (typeof m.name !== "string" || typeof framework.id !== "string") return [];
		return [
			{
				name: m.name,
				framework: { id: framework.id, name: typeof framework.name === "string" ? framework.name : framework.id },
				period: typeof m.period === "string" ? m.period : "",
				coveragePercent: typeof m.coveragePercent === "number" ? m.coveragePercent : 0,
				alerts: Array.isArray(m.alerts)
					? m.alerts.slice(0, 500).map((a) => ({
							controlId: String((a as Record<string, unknown> | null)?.controlId ?? "").slice(0, 60),
						}))
					: [],
			},
		];
	});
}

const WORDS = {
	en: {
		title: (project: string) => `Compliance: ${project}`,
		body: (r: MadeReport) =>
			`${r.framework.name} ${r.period}: ${r.coveragePercent}% of the controls covered, ` +
			`${r.alerts.length} without evidence for over 30 days (${r.alerts.map((a) => a.controlId).slice(0, 6).join(", ")}).`,
	},
	fr: {
		title: (project: string) => `Conformité : ${project}`,
		body: (r: MadeReport) =>
			`${r.framework.name} ${r.period} : ${r.coveragePercent} % des contrôles couverts, ` +
			`${r.alerts.length} sans preuve depuis plus de 30 jours (${r.alerts.map((a) => a.controlId).slice(0, 6).join(", ")}).`,
	},
};

export function alertText(language: string, project: string, report: MadeReport): { title: string; body: string } {
	const words = language === "fr" ? WORDS.fr : WORDS.en;
	return { title: words.title(project), body: words.body(report) };
}

export interface MonthlyDeps {
	projects: () => { id: string; name: string; path: string }[];
	resolve: (projectPath: string) => string | null;
	run: (projectRoot: string) => Promise<unknown>;
	announce: (projectId: string, text: { title: string; body: string }) => void;
	language: () => string;
	now?: () => Date;
}

/** One pass over the projects, one at a time. Never throws. */
export async function checkMonthly(deps: MonthlyDeps): Promise<number> {
	let made = 0;
	const now = deps.now?.() ?? new Date();
	for (const project of deps.projects()) {
		const root = deps.resolve(project.path);
		if (!root || !monthlyDue(root, now)) continue;
		try {
			for (const report of readMade(await deps.run(root))) {
				made += 1;
				if (report.alerts.length > 0) {
					deps.announce(project.id, alertText(deps.language(), project.name, report));
				}
			}
		} catch (err) {
			console.warn(`[Compliance] The monthly report of ${project.name} failed:`, err);
		}
	}
	return made;
}

export function startMonthlyCompliance(deps: MonthlyDeps): () => void {
	let running = false;
	const tick = () => {
		if (running) return;
		running = true;
		void checkMonthly(deps).finally(() => {
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
