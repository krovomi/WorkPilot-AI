/**
 * @vitest-environment node
 *
 * The project a GitHub handler works on: a local project only when its folder
 * is an existing directory given as an absolute path, a server project as it
 * is (nothing is read from its folder). The senders put the project id in
 * front of each message to the window.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ local: undefined as unknown, feature: undefined as unknown }));
vi.mock("../../../../project-store", () => ({ projectStore: { getProject: () => state.local } }));
vi.mock("../../../server-feature-files", () => ({ featureProject: () => state.feature }));

import type { BrowserWindow } from "electron";
import { createIPCCommunicators } from "../ipc-communicator";
import { withForgeProjectOrNull, withProjectOrNull } from "../project-middleware";

let root: string;
const handler = vi.fn(async (project: { id: string }) => `ran for ${project.id}`);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-middleware-"));
	state.local = undefined;
	state.feature = undefined;
	handler.mockClear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("withProjectOrNull", () => {
	it("runs the handler for a project whose folder exists, a name with two dots included", async () => {
		const folder = path.join(root, "my..app");
		mkdirSync(folder);
		state.local = { id: "p", path: folder };

		expect(await withProjectOrNull("p", handler)).toBe("ran for p");
		expect(handler).toHaveBeenCalledWith(state.local);
	});

	it("answers null for an unknown project and for a folder it cannot use", async () => {
		expect(await withProjectOrNull("nope", handler)).toBeNull();

		const file = path.join(root, "file");
		writeFileSync(file, "");
		for (const folder of ["relative/path", path.join(root, "missing"), file]) {
			state.local = { id: "p", path: folder };
			expect(await withProjectOrNull("p", handler)).toBeNull();
		}
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("withForgeProjectOrNull", () => {
	it("runs a server project without looking for its folder", async () => {
		state.feature = { id: "s", path: path.join(root, "never-created"), remote: { serverUrl: "https://s.invalid" } };

		expect(await withForgeProjectOrNull("s", handler)).toBe("ran for s");
	});

	it("checks a local project as withProjectOrNull does", async () => {
		state.feature = { id: "p", path: root };
		state.local = { id: "p", path: root };
		expect(await withForgeProjectOrNull("p", handler)).toBe("ran for p");

		state.feature = undefined;
		state.local = { id: "p", path: path.join(root, "missing") };
		expect(await withForgeProjectOrNull("p", handler)).toBeNull();
	});
});

describe("createIPCCommunicators", () => {
	it("sends progress, errors and the result on their channels, after the project id", () => {
		const send = vi.fn();
		const window = { webContents: { send } } as unknown as BrowserWindow;

		const { sendProgress, sendError, sendComplete } = createIPCCommunicators<{ step: number }, { ok: boolean }>(
			window,
			{ progress: "progress-channel", error: "error-channel", complete: "complete-channel" },
			"p",
		);
		sendProgress({ step: 1 });
		sendError("boom");
		sendError({ error: "rate limited", retryAfter: 60 });
		sendComplete({ ok: true });

		expect(send.mock.calls).toEqual([
			["progress-channel", "p", { step: 1 }],
			["error-channel", "p", { error: "boom" }],
			["error-channel", "p", { error: "rate limited", retryAfter: 60 }],
			["complete-channel", "p", { ok: true }],
		]);
	});
});
