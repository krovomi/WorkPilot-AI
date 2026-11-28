/**
 * What « Interroger le tableau » reads besides the cards (docs/architecture/
 * board-ask.md, lot 4): the roadmap's features, the ideas of Ideation and the
 * changes merged into the project's branch. A product owner asking « was this
 * already done? » wants the plan and the history too, not only the board.
 *
 * Each source is read from the project's own folder: the files under
 * `.workpilot/` resolved inside it and bounded, the history from `git log`
 * started without a shell. What cannot be read is left out; nothing fails.
 * A roadmap feature already turned into a card, and an idea already turned
 * into a task, are not read twice.
 */

import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../shared/constants/config";
import type { AppSettings, BoardAskSource, BoardAskState, Task } from "../../shared/types";
import { BOARD_ASK_SOURCES } from "../../shared/types/board-ask";
import { getToolPath } from "../cli-tool-manager";
import { readSettingsFile } from "../settings-utils";
import { isPathWithinBase } from "../worktree-paths";
import type { BoardTicket } from "./tickets";

/** A source file larger than this is not read. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
/** Items read per file source. */
export const MAX_SOURCE_ITEMS = 500;
/** Commits of the branch's history read, newest first. */
export const MAX_CHANGES = 300;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const TEXT_CHARS = 2000;
const LINE_CHARS = 300;
const MAX_LINES = 12;

const FIELD = "\x1f";
const RECORD = "\x1e";

/** Runs git in a folder with arguments, and gives its stdout, or null. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string | null>;

const runGit: GitRunner = (cwd, args) =>
	new Promise((resolve) => {
		try {
			execFile(
				getToolPath("git"),
				[...args],
				{ cwd, encoding: "utf-8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
				(error, stdout) => resolve(error ? null : stdout),
			);
		} catch {
			resolve(null);
		}
	});

function text(value: unknown, max = TEXT_CHARS): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function lines(value: unknown): string[] {
	return (Array.isArray(value) ? value : [])
		.map((line) => text(line, LINE_CHARS))
		.filter(Boolean)
		.slice(0, MAX_LINES);
}

/** The JSON object of a file of the project, read only inside it, or null. */
export function readProjectJson(projectDir: string, ...segments: string[]): Record<string, unknown> | null {
	try {
		const root = realpathSync(projectDir);
		const file = realpathSync(path.join(root, ...segments));
		if (!isPathWithinBase(file, root)) return null;
		// One descriptor: the file measured is the file read, up to that size.
		const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
			const buffer = Buffer.alloc(stat.size);
			const read = readSync(fd, buffer, 0, stat.size, 0);
			const parsed: unknown = JSON.parse(buffer.toString("utf-8", 0, read));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

function items(data: Record<string, unknown> | null, key: string): Record<string, unknown>[] {
	const list = data?.[key];
	return (Array.isArray(list) ? list : [])
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.slice(0, MAX_SOURCE_ITEMS);
}

function roadmapState(status: unknown): BoardAskState {
	if (status === "done" || status === "completed") return "done";
	if (status === "in_progress") return "in_progress";
	return "planned";
}

/** The roadmap's features not yet turned into a card of the board. */
export function readRoadmapTickets(projectDir: string, tasks: readonly Task[]): BoardTicket[] {
	const specs = new Set(tasks.map((task) => task.specId).filter(Boolean));
	const data = readProjectJson(projectDir, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
	return items(data, "features").flatMap((feature): BoardTicket[] => {
		const id = text(feature.id, 200);
		const title = text(feature.title, LINE_CHARS);
		const linked = text(feature.linked_spec_id ?? feature.linkedSpecId, 200);
		if (!id || !title || (linked && specs.has(linked))) return [];
		return [
			{
				id: `roadmap:${id}`,
				title,
				description: text(feature.description),
				spec: text(feature.rationale),
				subtasks: [
					...lines(feature.acceptance_criteria ?? feature.acceptanceCriteria),
					...lines(feature.user_stories ?? feature.userStories),
				].slice(0, MAX_LINES),
				files: [],
				state: roadmapState(feature.status),
				archived: false,
				kind: "roadmap",
			},
		];
	});
}

function ideaState(status: unknown): BoardAskState {
	return status === "dismissed" || status === "archived" ? "abandoned" : "planned";
}

/** The ideas of Ideation not yet turned into a task of the board. */
export function readIdeaTickets(projectDir: string, tasks: readonly Task[]): BoardTicket[] {
	const taskIds = new Set(tasks.map((task) => task.id));
	const data = readProjectJson(projectDir, AUTO_BUILD_PATHS.IDEATION_DIR, AUTO_BUILD_PATHS.IDEATION_FILE);
	return items(data, "ideas").flatMap((idea): BoardTicket[] => {
		const id = text(idea.id, 200);
		const title = text(idea.title, LINE_CHARS);
		const linked = text(idea.linked_task_id ?? idea.linkedTaskId, 200);
		if (!id || !title || (linked && taskIds.has(linked))) return [];
		const proposal = text(idea.proposed_change ?? idea.proposedChange ?? idea.implementation);
		const created = text(idea.created_at ?? idea.createdAt, 40);
		return [
			{
				id: `idea:${id}`,
				title,
				description: text(idea.description),
				spec: [text(idea.rationale), proposal].filter(Boolean).join("\n").slice(0, TEXT_CHARS),
				subtasks: [],
				files: lines(idea.affected_files ?? idea.affectedFiles),
				state: ideaState(idea.status),
				...(created && !Number.isNaN(Date.parse(created)) ? { updatedAt: new Date(created).toISOString() } : {}),
				archived: idea.status === "archived",
				kind: "idea",
			},
		];
	});
}

const PR_MERGE = /^Merge pull request #(\d+)\b/;
const PR_SUFFIX = /\(#(\d+)\)\s*$/;
const NOISE = /^(?:Merge (?:branch|remote-tracking branch|tag)\b|(?:build|chore)\(deps[^)]*\)|Bump\s)/i;

/** One commit of the history as a ticket, or null when it says nothing a person would look for. */
export function changeTicket(record: string): BoardTicket | null {
	const [sha = "", date = "", subject = "", body = ""] = record.split(FIELD).map((part) => part.trim());
	if (!/^[0-9a-f]{7,64}$/i.test(sha) || !subject || NOISE.test(subject)) return null;
	const merged = PR_MERGE.exec(subject);
	const bodyLines = body.split(/\r?\n/).map((line) => line.trim());
	// A merge commit's subject only names the branch: its body's first line is the pull request's title.
	const title = merged ? (bodyLines.find(Boolean) ?? "") : subject;
	if (!title) return null;
	const number = merged?.[1] ?? PR_SUFFIX.exec(subject)?.[1];
	const description = (merged ? bodyLines.slice(bodyLines.indexOf(title) + 1) : bodyLines)
		.filter((line) => line && !/^(?:Co-Authored-By|Signed-off-by|Claude-Session):/i.test(line))
		.join("\n");
	const when = Date.parse(date);
	return {
		id: `change:${sha.toLowerCase()}`,
		title: title.slice(0, LINE_CHARS),
		description: description.slice(0, TEXT_CHARS),
		spec: "",
		subtasks: [],
		files: [],
		state: "done",
		...(Number.isNaN(when) ? {} : { updatedAt: new Date(when).toISOString() }),
		archived: false,
		kind: "change",
		ref: number ? `#${number}` : sha.slice(0, 8).toLowerCase(),
	};
}

/** The changes merged into the project's current branch, newest first. */
export async function readChangeTickets(projectDir: string, git: GitRunner = runGit): Promise<BoardTicket[]> {
	const stdout = await git(projectDir, [
		"log",
		"--first-parent",
		`--max-count=${MAX_CHANGES}`,
		`--format=%H${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`,
		"HEAD",
	]);
	if (!stdout) return [];
	return stdout
		.split(RECORD)
		.map(changeTicket)
		.filter((ticket): ticket is BoardTicket => ticket !== null);
}

/** The sources in the settings, every one when the settings name none. */
export function boardSources(settings: Partial<AppSettings> | undefined): BoardAskSource[] {
	const value = settings?.boardAskSources;
	if (!Array.isArray(value)) return [...BOARD_ASK_SOURCES];
	return BOARD_ASK_SOURCES.filter((source) => value.includes(source));
}

export function readBoardSourcesSetting(): BoardAskSource[] {
	try {
		return boardSources((readSettingsFile() ?? {}) as Partial<AppSettings>);
	} catch {
		return [...BOARD_ASK_SOURCES];
	}
}

/** Every ticket of the sources asked, for a project folder. */
export async function readBoardSources(
	projectDir: string,
	tasks: readonly Task[],
	sources: readonly BoardAskSource[],
	git?: GitRunner,
): Promise<BoardTicket[]> {
	return [
		...(sources.includes("roadmap") ? readRoadmapTickets(projectDir, tasks) : []),
		...(sources.includes("ideas") ? readIdeaTickets(projectDir, tasks) : []),
		...(sources.includes("history") ? await readChangeTickets(projectDir, git) : []),
	];
}
