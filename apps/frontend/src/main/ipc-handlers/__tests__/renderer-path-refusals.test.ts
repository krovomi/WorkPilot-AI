/**
 * @vitest-environment node
 *
 * The handlers that read or write a file the renderer names resolve it inside
 * a registered project first. Each case sends what a compromised renderer
 * would and checks that nothing outside the project is read or written.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: "",
}));

vi.mock("electron", () => ({
	app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			state.handlers.set(channel, handler),
		on: vi.fn(),
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === "p1" ? { id: "p1", path: state.project } : undefined,
		getProjects: () => [{ id: "p1", path: state.project }],
	},
}));

vi.mock("../../changelog-service", () => ({
	changelogService: { on: vi.fn(), configure: vi.fn() },
}));

vi.mock("../../architecture-visualizer-service", () => ({
	architectureVisualizerService: { on: vi.fn() },
}));

let base: string;
let outside: string;

function call(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<{
		success: boolean;
		data?: unknown;
	}>;
}

beforeAll(async () => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "m6-refusals-")));
	state.project = path.join(base, "repo");
	outside = path.join(base, "outside");
	mkdirSync(path.join(state.project, "shots"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(path.join(state.project, "shots", "home.png"), "png");
	writeFileSync(path.join(outside, "secret.png"), "secret");
	writeFileSync(path.join(outside, "map.html"), "<html></html>");
	symlinkSync(outside, path.join(state.project, "link"), "junction");

	const { registerChangelogHandlers } = await import("../changelog-handlers");
	registerChangelogHandlers(() => null);
	const { registerBrowserAgentHandlers } = await import(
		"../browser-agent-handlers"
	);
	registerBrowserAgentHandlers(() => null);
	const { registerArchitectureVisualizerHandlers } = await import(
		"../architecture-visualizer-handlers"
	);
	registerArchitectureVisualizerHandlers();
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("changelog images", () => {
	it("reads an image inside the project", async () => {
		const result = await call(
			IPC_CHANNELS.CHANGELOG_READ_LOCAL_IMAGE,
			state.project,
			"shots/home.png",
		);
		expect(result.success).toBe(true);
	});

	it("refuses to read outside the project, through .. or a link", async () => {
		for (const relative of [
			"../outside/secret.png",
			"link/secret.png",
			path.join(outside, "secret.png"),
		]) {
			const result = await call(
				IPC_CHANNELS.CHANGELOG_READ_LOCAL_IMAGE,
				state.project,
				relative,
			);
			expect(result.success, relative).toBe(false);
		}
	});

	it("refuses a project directory the user never added", async () => {
		const result = await call(
			IPC_CHANNELS.CHANGELOG_READ_LOCAL_IMAGE,
			outside,
			"secret.png",
		);
		expect(result.success).toBe(false);
	});

	it("refuses to save under a name that leaves the assets folder", async () => {
		for (const filename of [
			"../../../outside/x.png",
			"../x.png",
			".bashrc",
			"payload.sh",
		]) {
			const result = await call(
				IPC_CHANNELS.CHANGELOG_SAVE_IMAGE,
				"p1",
				"aGVsbG8=",
				filename,
			);
			expect(result.success, filename).toBe(false);
		}
		expect(existsSync(path.join(outside, "x.png"))).toBe(false);
		expect(existsSync(path.join(state.project, ".github", "x.png"))).toBe(
			false,
		);
	});
});

describe("browser agent screenshots", () => {
	it("reads a screenshot inside the project", async () => {
		const result = await call(
			IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
			path.join(state.project, "shots", "home.png"),
		);
		expect(result.success).toBe(true);
	});

	it("refuses any other file", async () => {
		for (const target of [
			path.join(outside, "secret.png"),
			path.join(state.project, "link", "secret.png"),
			path.join(state.project, "..", "outside", "secret.png"),
		]) {
			const result = await call(
				IPC_CHANNELS.BROWSER_AGENT_GET_SCREENSHOT_IMAGE,
				target,
			);
			expect(result.success, target).toBe(false);
		}
	});
});

describe("architecture artifacts", () => {
	it("refuses an artifact outside the project", async () => {
		const result = await call(
			IPC_CHANNELS.ARCHITECTURE_ARTIFACT_READ,
			path.join(outside, "map.html"),
		);
		expect(result.success).toBe(false);
	});

	it("reads no delta record outside the project", async () => {
		const result = await call(IPC_CHANNELS.ARCHITECTURE_DELTA_READ, outside);
		expect(result).toEqual({ success: true, data: null });
	});
});
