/**
 * The recorder bridge: one typed function per channel, arguments as data.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
const listeners: Array<[string, (event: unknown) => void]> = [];
vi.mock("../ipc-utils", () => ({
	invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])),
	createIpcListener: (channel: string, callback: (event: unknown) => void) => {
		listeners.push([channel, callback]);
		return () => undefined;
	},
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createBrowserRecorderAPI } from "../browser-recorder-api";

describe("createBrowserRecorderAPI", () => {
	it("invokes each recorder channel with its arguments", async () => {
		const api = createBrowserRecorderAPI();
		await api.startBrowserRecording("/p", "http://a.test");
		expect(invokeIpc).toHaveBeenLastCalledWith(IPC_CHANNELS.BROWSER_AGENT_RECORD_START, "/p", "http://a.test");
		await api.stopBrowserRecording();
		expect(invokeIpc).toHaveBeenLastCalledWith(IPC_CHANNELS.BROWSER_AGENT_RECORD_STOP);
		await api.answerBrowserRecorderDialog({ id: 1, accept: false, text: "" });
		expect(invokeIpc).toHaveBeenLastCalledWith(IPC_CHANNELS.BROWSER_AGENT_RECORD_DIALOG, {
			id: 1,
			accept: false,
			text: "",
		});
		const request = { format: "cypress", destination: "preview", name: "", stepIds: ["s1"] } as const;
		await api.exportBrowserRecording("/p", request);
		expect(invokeIpc).toHaveBeenLastCalledWith(IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT, "/p", request);
	});

	it("hears the record events", () => {
		const heard: unknown[] = [];
		createBrowserRecorderAPI().onBrowserRecorderEvent((event) => heard.push(event));
		const [[channel, callback]] = listeners;
		expect(channel).toBe(IPC_CHANNELS.BROWSER_AGENT_RECORD_EVENT);
		callback({ type: "started", url: "http://a.test/" });
		expect(heard).toEqual([{ type: "started", url: "http://a.test/" }]);
	});
});
