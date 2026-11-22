/**
 * The trusted signers of a project's memory (#352): the renderer sends lines
 * of text, main checks their shape before the backend parses each key, and a
 * server project's memory has no list (its brain is never synced).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	projects: new Map<string, { id: string; path: string; remote?: unknown }>(),
	backendFetch: vi.fn(),
	authedFetch: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
	},
}));
vi.mock("../../_backend-fetch", () => ({ backendFetch: state.backendFetch }));
vi.mock("../../../server-connection", () => ({ authedFetch: state.authedFetch }));
vi.mock("../../server-feature-files", () => ({
	featureProject: (id: unknown) => (typeof id === "string" ? state.projects.get(id) : undefined),
}));

import { registerMemoryLifecycleHandlers } from "../memory-lifecycle-handlers";
import { MAX_SIGNERS, signerLines } from "../memory-lifecycle-validation";

const LINE = "alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample";
const SIGNER = { name: "alice@example.com", kind: "ssh", fingerprint: "SHA256:abc" };

function call(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<{ success: boolean; error?: string; data?: unknown }>;
}

beforeEach(() => {
	state.handlers.clear();
	state.projects.clear();
	state.backendFetch.mockReset();
	state.projects.set("p1", { id: "p1", path: "/work/shop" });
	state.projects.set("remote", { id: "remote", path: "/srv/x", remote: { serverId: "s" } });
	registerMemoryLifecycleHandlers();
});

describe("the trusted signers' lines are checked in main", () => {
	it.each([
		["not a list", "alice"],
		["an empty line", [""]],
		["a line with a newline", ["alice\nbob"]],
		["a number", [42]],
		["a line too long", [`alice ${"A".repeat(1300)}`]],
		["too many lines", Array.from({ length: MAX_SIGNERS + 1 }, (_, n) => `p${n} ${"A".repeat(40)}`)],
	])("refuses %s", async (_label, hostile) => {
		expect(signerLines(hostile)).toBeNull();
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SIGNERS, "p1", hostile)).toEqual({
			success: false,
			error: "invalid",
		});
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("has no list for a server project", async () => {
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SIGNERS, "remote", [LINE])).toEqual({
			success: false,
			error: "server-project",
		});
		expect(state.backendFetch).not.toHaveBeenCalled();
	});

	it("sends the trimmed lines with the project's own path", async () => {
		state.backendFetch.mockResolvedValueOnce({ success: true, signers: [SIGNER] });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SIGNERS, "p1", [`  ${LINE} `])).toEqual({
			success: true,
			data: [SIGNER],
		});
		const [path, init] = state.backendFetch.mock.calls[0];
		expect(path).toBe("/api/brain/memory/signers");
		expect(JSON.parse(init.body)).toEqual({ project_dir: "/work/shop", lines: [LINE] });
		state.backendFetch.mockResolvedValueOnce({ success: true });
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SIGNERS, "p1", [])).toEqual({
			success: true,
			data: [],
		});
		state.backendFetch.mockResolvedValueOnce({
			success: false,
			error: "maintainer-only",
			code: "maintainer-only",
		});
		expect(await call(IPC_CHANNELS.CONTEXT_MEMORY_SET_SIGNERS, "p1", [LINE])).toEqual({
			success: false,
			error: "maintainer-only",
		});
	});

	it("reads the list, the marks and this machine's signing in the lifecycle view", async () => {
		state.backendFetch.mockResolvedValueOnce({
			success: true,
			signers: [SIGNER],
			signers_rejected: 2,
			signing: true,
			can_edit_signers: false,
			unverified: ["knowledge/projects/shop/memory/gotchas/x.md"],
		});
		const view = await call(IPC_CHANNELS.CONTEXT_MEMORY_LIFECYCLE, "p1");
		expect(view.data).toMatchObject({
			signers: [SIGNER],
			signersRejected: 2,
			signing: true,
			canEditSigners: false,
			unverified: ["knowledge/projects/shop/memory/gotchas/x.md"],
		});
	});
});
