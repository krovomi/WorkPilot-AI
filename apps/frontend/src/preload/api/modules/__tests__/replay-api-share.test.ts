/**
 * The replay bridge forwards each sharing call on its own channel, as data.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createReplayAPI } from "../replay-api";

describe("createReplayAPI sharing", () => {
	const api = createReplayAPI();
	const options = {
		format: "html" as const,
		stripReasoning: true,
		stripTokens: false,
		includeFileContents: false,
		language: "en" as const,
	};

	it.each([
		[() => api.exportReplaySession("s1", options), IPC_CHANNELS.REPLAY_EXPORT_SESSION, ["s1", options]],
		[() => api.importReplaySession(), IPC_CHANNELS.REPLAY_IMPORT_SESSION, []],
		[
			() => api.addReplayBookmark("s1", { stepIndex: 2, note: "n" }),
			IPC_CHANNELS.REPLAY_ADD_BOOKMARK,
			["s1", { stepIndex: 2, note: "n" }],
		],
		[() => api.removeReplayBookmark("s1", "b1"), IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK, ["s1", "b1"]],
	])("%#: forwards on its channel", async (run, channel, args) => {
		invokeIpc.mockClear();
		await run();
		expect(invokeIpc).toHaveBeenCalledWith(channel, ...args);
	});
});
