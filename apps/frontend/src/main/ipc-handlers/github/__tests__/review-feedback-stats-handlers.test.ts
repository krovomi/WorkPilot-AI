/**
 * The three channels of the project-wide review feedback (#361, lot 2): every
 * argument the renderer sends is checked before a project is looked up, a
 * server project is answered without touching a folder, an unknown project
 * or signature is refused, and the reset and the conventions file land in the
 * project's own folder.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const handlers = vi.hoisted(
	() => new Map<string, (...args: unknown[]) => Promise<unknown>>(),
);
const state = vi.hoisted(() => ({
	projects: new Map<string, { path: string }>(),
	remote: new Set<string>(),
	looked: [] as string[],
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) =>
			handlers.set(channel, fn),
	},
}));
vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));
vi.mock("../../server-review-jobs", () => ({
	serverProjectOf: (id: unknown) =>
		typeof id === "string" && state.remote.has(id) ? { id } : undefined,
}));
vi.mock("../utils/project-middleware", () => ({
	withProjectOrNull: async (
		id: string,
		fn: (project: { path: string }) => Promise<unknown>,
	) => {
		state.looked.push(id);
		const project = state.projects.get(id);
		return project ? fn(project) : null;
	},
}));
vi.mock("../utils/subprocess-runner", () => ({ getBackendPath: () => null }));
vi.mock("../../../source-env", () => ({ loadBackendEnv: () => ({}) }));

import { signature } from "../review-feedback-dataset";
import { registerReviewFeedbackStatsHandlers } from "../review-feedback-stats-handlers";
import { FEEDBACK_RELATIVE_PATH } from "../review-feedback-store";

const STATS = IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_STATS;
const RESET = IPC_CHANNELS.GITHUB_PR_REVIEW_FEEDBACK_RESET;
const WRITE = IPC_CHANNELS.GITHUB_PR_REVIEW_CONVENTIONS_WRITE;
const SIG = signature("style", "Nit on `a`");

let root: string;

function call(channel: string, ...args: unknown[]) {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args);
}

beforeEach(() => {
	handlers.clear();
	state.projects.clear();
	state.remote.clear();
	state.looked = [];
	vi.stubEnv("WORKPILOT_REVIEW_FEEDBACK_THRESHOLD", "");
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-stats-ipc-")));
	mkdirSync(path.join(root, ".workpilot"));
	const lines = [0, 1, 2].map((i) =>
		JSON.stringify({
			v: 1,
			pr: 10 + i,
			finding_id: `f${i}`,
			verdict: "rejected",
			reason: "too_pedantic",
			category: "style",
			severity: "low",
			title: `Nit on \`x${i}\``,
		}),
	);
	writeFileSync(path.join(root, FEEDBACK_RELATIVE_PATH), `${lines.join("\n")}\n`);
	state.projects.set("p1", { path: root });
	state.remote.add("remote");
	registerReviewFeedbackStatsHandlers();
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("stats", () => {
	it("answers the project's acceptance rate and learned rules", async () => {
		const result = (await call(STATS, "p1")) as {
			success: true;
			stats: { threshold: number; rules: Array<{ signature: string }> };
		};
		expect(result.success).toBe(true);
		expect(result.stats.threshold).toBe(3);
		expect(result.stats.rules.map((rule) => rule.signature)).toEqual([SIG]);
	});

	it("refuses a project id that is not a string, before any lookup", async () => {
		expect(await call(STATS, { path: "/etc" })).toEqual({
			success: false,
			error: "invalid",
		});
		expect(state.looked).toEqual([]);
	});

	it("answers a server project and an unknown one", async () => {
		expect(await call(STATS, "remote")).toEqual({
			success: false,
			error: "server_project",
		});
		expect(await call(STATS, "nope")).toEqual({ success: false, error: "not_found" });
	});
});

describe("reset", () => {
	it("forgets a learned rule and answers the stats without it", async () => {
		const result = (await call(RESET, "p1", SIG)) as {
			success: true;
			stats: { rules: unknown[] };
		};
		expect(result.success).toBe(true);
		expect(result.stats.rules).toEqual([]);
		const last = readFileSync(path.join(root, FEEDBACK_RELATIVE_PATH), "utf-8")
			.trim()
			.split("\n")
			.at(-1);
		expect(JSON.parse(last ?? "{}")).toMatchObject({ kind: "reset", signature: SIG });
	});

	it.each([
		["a number", 7],
		["a path", "../../.ssh/id_rsa"],
		["an object", { signature: "0123456789abcdef" }],
	])("refuses a signature that is %s, before any lookup", async (_name, value) => {
		expect(await call(RESET, "p1", value)).toEqual({
			success: false,
			error: "invalid",
		});
		expect(state.looked).toEqual([]);
	});

	it("refuses a signature the dataset does not hold", async () => {
		expect(await call(RESET, "p1", "0123456789abcdef")).toEqual({
			success: false,
			error: "not_found",
		});
	});

	it("answers a server project, an invalid id and an unknown project", async () => {
		expect(await call(RESET, "remote", SIG)).toEqual({
			success: false,
			error: "server_project",
		});
		expect(await call(RESET, 1, SIG)).toEqual({ success: false, error: "invalid" });
		expect(await call(RESET, "nope", SIG)).toEqual({
			success: false,
			error: "not_found",
		});
	});
});

describe("conventions", () => {
	it("writes the file in the project", async () => {
		expect(await call(WRITE, "p1")).toEqual({
			success: true,
			path: ".workpilot/review-conventions.md",
			rules: 1,
		});
		expect(existsSync(path.join(root, ".workpilot", "review-conventions.md"))).toBe(
			true,
		);
	});

	it("answers a server project, an invalid id and an unknown project", async () => {
		expect(await call(WRITE, "remote")).toEqual({
			success: false,
			error: "server_project",
		});
		expect(await call(WRITE, null)).toEqual({ success: false, error: "invalid" });
		expect(await call(WRITE, "nope")).toEqual({ success: false, error: "not_found" });
	});
});
