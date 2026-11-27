/**
 * Who created a task, who launched it, and what its agents spent: the facts
 * a finished card shows (`renderer/components/kanban/TaskRunFacts.tsx`).
 *
 * - **People** live beside the spec in `task_people.json`
 *   (`{version: 1, createdBy?, startedBy?}`), each `{kind, name?, at?}`.
 *   On this computer the app writes it when it creates a card and each time
 *   it launches one, with the person's git identity (`user.name`, else the
 *   system account's name). A card the file does not cover yet (created by
 *   the backend, an import, or before this file existed) is credited to the
 *   same local identity, or to the automation that made it. On a server
 *   project the server sends the file in the board's snapshot, built from its
 *   accounts (`shared_board/run_facts.py`): it is never written there.
 * - **Spend** is added up per card from the ledger every agent session
 *   appends to (`.workpilot/cost_data.json`, `core/usage_tracker.py`), at the
 *   project root and in the task workspaces still on disk, whatever the
 *   provider. A server project's snapshot carries `usage_summary.json`
 *   instead, added up from its `usage_records`. No session, or sessions that
 *   reported nothing: the spend is unknown, never 0.
 *
 * Only totals: no prompt, no answer, no file name. The name is the one the
 * person's own git commits already carry, and it goes with the card.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Task,
	TaskPerson,
	TaskRunFacts,
	TaskUsageTotals,
} from "../shared/types";
import { getToolPath } from "./cli-tool-manager";
import { COST_DATA_FILE, ledgerDirs, readLedger } from "./workspace-ledgers";

export const PEOPLE_FILE = "task_people.json";
export const USAGE_SUMMARY_FILE = "usage_summary.json";

const MAX_NAME = 120;
const MAX_MODELS = 3;
/** How long a project's git identity is reused before asking git again. */
const IDENTITY_TTL_MS = 60_000;

type LocalIdentity = (projectPath: string) => string | undefined;

/* ------------------------------------------------------------------ people */

/** A display name: one printable line, bounded; undefined for anything else. */
export function cleanName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim().slice(0, MAX_NAME);
	if (!name) return undefined;
	for (const ch of name) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return undefined;
	}
	return name;
}

function cleanDate(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 40) return undefined;
	return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function toPerson(raw: unknown): TaskPerson | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (r.kind !== "person" && r.kind !== "automation") return undefined;
	const person: TaskPerson = { kind: r.kind };
	const name = cleanName(r.name);
	if (name) person.name = name;
	const at = cleanDate(r.at);
	if (at) person.at = at;
	return person;
}

export interface PeopleFile {
	createdBy?: TaskPerson;
	startedBy?: TaskPerson;
}

function readJson(file: string, limit: number): unknown {
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > limit) return null;
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

export function readPeople(specDir: string): PeopleFile {
	const raw = readJson(path.join(specDir, PEOPLE_FILE), 10_000);
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const people: PeopleFile = {};
	const createdBy = toPerson(r.createdBy);
	if (createdBy) people.createdBy = createdBy;
	const startedBy = toPerson(r.startedBy);
	if (startedBy) people.startedBy = startedBy;
	return people;
}

function writePeople(specDir: string, people: PeopleFile): void {
	const target = path.join(specDir, PEOPLE_FILE);
	const temp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(
		temp,
		JSON.stringify({ version: 1, ...people }, null, 2),
		"utf-8",
	);
	fs.renameSync(temp, target);
}

const identities = new Map<string, { name: string | undefined; at: number }>();

/**
 * The name this computer's person goes by in a project: git's `user.name`
 * there (a project may set its own), else the system account's name.
 */
export function gitIdentityName(
	git: string,
	projectPath: string,
	now: number = Date.now(),
): string | undefined {
	const cached = identities.get(projectPath);
	if (cached && now - cached.at < IDENTITY_TTL_MS) return cached.name;
	let name: string | undefined;
	try {
		name = cleanName(
			execFileSync(git, ["config", "user.name"], {
				cwd: projectPath,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3_000,
			}),
		);
	} catch {
		name = undefined;
	}
	if (!name) {
		try {
			name = cleanName(os.userInfo().username);
		} catch {
			name = undefined;
		}
	}
	identities.set(projectPath, { name, at: now });
	return name;
}

/** Forget the cached identities (tests, or after the person sets theirs). */
export function forgetIdentities(): void {
	identities.clear();
}

function defaultIdentity(projectPath: string): string | undefined {
	return gitIdentityName(getToolPath("git"), projectPath);
}

/**
 * Note who created a card made on this computer. Never throws: a card
 * whose author cannot be written is still a card.
 */
export function recordTaskCreator(
	specDir: string,
	projectPath: string,
	kind: TaskPerson["kind"] = "person",
	identity: LocalIdentity = defaultIdentity,
): void {
	try {
		const people = readPeople(specDir);
		const createdBy: TaskPerson = { kind, at: new Date().toISOString() };
		const name = kind === "person" ? identity(projectPath) : undefined;
		if (name) createdBy.name = name;
		writePeople(specDir, { ...people, createdBy });
	} catch (error) {
		console.warn("[task-run-facts] creator not recorded:", error);
	}
}

/** Note who launched a card's run, on this computer. Never throws. */
export function recordTaskLauncher(
	specDir: string,
	projectPath: string,
	identity: LocalIdentity = defaultIdentity,
	at: Date = new Date(),
): void {
	try {
		const people = readPeople(specDir);
		const startedBy: TaskPerson = { kind: "person", at: at.toISOString() };
		const name = identity(projectPath);
		if (name) startedBy.name = name;
		writePeople(specDir, { ...people, startedBy });
	} catch (error) {
		console.warn("[task-run-facts] launcher not recorded:", error);
	}
}

/* ------------------------------------------------------------------- spend */

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

interface Accumulator {
	totals: TaskUsageTotals;
	models: Map<string, number>;
}

function emptyTotals(): TaskUsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		sessions: 0,
		estimatedSessions: 0,
		models: [],
	};
}

function add(acc: Map<string, Accumulator>, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const u = raw as Record<string, unknown>;
	const spec =
		(typeof u.spec_id === "string" && u.spec_id) ||
		(typeof u.task_id === "string" && u.task_id) ||
		"";
	if (!spec || spec.length > 200) return;
	let entry = acc.get(spec);
	if (!entry) {
		entry = { totals: emptyTotals(), models: new Map() };
		acc.set(spec, entry);
	}
	const t = entry.totals;
	t.inputTokens += count(u.input_tokens);
	t.outputTokens += count(u.output_tokens);
	t.cacheWriteTokens += count(u.cache_creation_input_tokens);
	t.cacheReadTokens += count(u.cache_read_input_tokens);
	t.costUsd += count(u.cost);
	t.sessions += 1;
	if (u.usage_source === "estimated") t.estimatedSessions += 1;
	const model = cleanName(u.model);
	if (model && model !== "unknown") {
		entry.models.set(model, (entry.models.get(model) ?? 0) + 1);
	}
}

function finish(acc: Map<string, Accumulator>): Map<string, TaskUsageTotals> {
	const out = new Map<string, TaskUsageTotals>();
	for (const [spec, { totals, models }] of acc) {
		totals.models = [...models.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_MODELS)
			.map(([model]) => model);
		out.set(spec, totals);
	}
	return out;
}

/** A usage that tells something: a token counted, or a price paid. */
export function knownUsage(
	totals: TaskUsageTotals | undefined,
): TaskUsageTotals | undefined {
	if (!totals || totals.sessions === 0) return undefined;
	const tokens =
		totals.inputTokens +
		totals.outputTokens +
		totals.cacheReadTokens +
		totals.cacheWriteTokens;
	return tokens > 0 || totals.costUsd > 0 ? totals : undefined;
}

const ledgerCache = new Map<
	string,
	{ mtimeMs: number; size: number; rows: unknown[] }
>();

/** One ledger's rows, parsed again only when the file changed. */
function ledgerRows(dir: string): unknown[] {
	const target = path.join(dir, COST_DATA_FILE);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch {
		ledgerCache.delete(target);
		return [];
	}
	const cached = ledgerCache.get(target);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.rows;
	}
	const data = readLedger(dir, COST_DATA_FILE) as { usages?: unknown } | null;
	const rows = Array.isArray(data?.usages) ? data.usages : [];
	ledgerCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
	return rows;
}

/** What each card of a project on this computer spent, by spec id. */
export function usageBySpec(projectPath: string): Map<string, TaskUsageTotals> {
	const acc = new Map<string, Accumulator>();
	for (const dir of ledgerDirs(projectPath)) {
		for (const row of ledgerRows(dir)) add(acc, row);
	}
	return finish(acc);
}

/** The totals a server's snapshot sent for one card, checked again. */
export function readUsageSummary(specDir: string): TaskUsageTotals | undefined {
	const raw = readJson(path.join(specDir, USAGE_SUMMARY_FILE), 10_000);
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const totals: TaskUsageTotals = {
		inputTokens: count(r.inputTokens),
		outputTokens: count(r.outputTokens),
		cacheReadTokens: count(r.cacheReadTokens),
		cacheWriteTokens: count(r.cacheWriteTokens),
		costUsd: count(r.costUsd),
		sessions: Math.floor(count(r.sessions)),
		estimatedSessions: Math.floor(count(r.estimatedSessions)),
		models: Array.isArray(r.models)
			? r.models
					.map(cleanName)
					.filter((m): m is string => !!m)
					.slice(0, MAX_MODELS)
			: [],
	};
	return knownUsage(totals);
}

/* ---------------------------------------------------------------- the card */

export interface AttachOptions {
	/** The card's own folder in the project (`<project>/<specs>/<specId>`). */
	specDirOf: (task: Task) => string;
	/**
	 * A project on this computer: unrecorded people are its person, and the
	 * spend is read from its ledgers. False for a server project's mirror,
	 * whose snapshot says both.
	 */
	local: boolean;
	identity?: LocalIdentity;
}

/** The tasks, each with the facts its card shows once it is done. */
export function attachRunFacts(
	projectPath: string,
	tasks: Task[],
	options: AttachOptions,
): Task[] {
	if (tasks.length === 0) return tasks;
	const identity = options.identity ?? defaultIdentity;
	let usage: Map<string, TaskUsageTotals> = new Map();
	let localName: string | undefined;
	if (options.local) {
		try {
			usage = usageBySpec(projectPath);
		} catch (error) {
			console.warn("[task-run-facts] ledgers not read:", error);
		}
		localName = identity(projectPath);
	}
	return tasks.map((task) => {
		const specDir = options.specDirOf(task);
		const people = readPeople(specDir);
		const facts: TaskRunFacts = {};
		const localPerson = (): TaskPerson =>
			localName ? { kind: "person", name: localName } : { kind: "person" };
		const createdBy =
			people.createdBy ??
			(task.metadata?.automation
				? { kind: "automation" as const }
				: options.local
					? localPerson()
					: undefined);
		if (createdBy) facts.createdBy = createdBy;
		const ran = (task.statusHistory ?? []).some(
			(entry) => entry.to === "in_progress",
		);
		const startedBy =
			people.startedBy ?? (options.local && ran ? localPerson() : undefined);
		if (startedBy) facts.startedBy = startedBy;
		const spent = options.local
			? knownUsage(usage.get(task.specId))
			: readUsageSummary(specDir);
		if (spent) facts.usage = spent;
		return Object.keys(facts).length > 0 ? { ...task, runFacts: facts } : task;
	});
}
