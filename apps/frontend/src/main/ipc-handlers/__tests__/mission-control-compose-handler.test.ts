/**
 * The auto-compose channel: the request goes, unchanged, to the checks of
 * `suggestComposition`, with the project ids resolved by the project store.
 */
import { describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			handlers.set(channel, handler),
	},
}));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (id === "p1" ? { path: "/home/me/proj" } : undefined),
	},
}));
vi.mock("../../oneshot-llm", () => ({ runOneShotLLM: vi.fn() }));
vi.mock("../_backend-fetch", () => ({ backendFetch: vi.fn() }));
const suggestComposition = vi.fn(async () => ({ success: true, data: {} }));
vi.mock("../../mission-control/mission-control-composition", () => ({
	suggestComposition: (...args: unknown[]) => suggestComposition(...(args as [])),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerMissionControlHandlers } from "../mission-control-handlers";

describe("MISSION_CONTROL_SUGGEST_COMPOSITION", () => {
	it("hands the request to suggestComposition with the project lookup", async () => {
		const backendFetch = vi.fn();
		const runOneShotLLM = vi.fn();
		registerMissionControlHandlers({ backendFetch, runOneShotLLM } as never);
		const request = { providers: ["anthropic"], projectId: "p1" };
		const res = await handlers.get(IPC_CHANNELS.MISSION_CONTROL_SUGGEST_COMPOSITION)?.(
			{},
			request,
		);
		expect(res).toEqual({ success: true, data: {} });
		const [deps, sent] = suggestComposition.mock.calls[0] as unknown as [
			{ projectPath: (id: unknown) => string | undefined; backendFetch: unknown },
			unknown,
		];
		expect(sent).toBe(request);
		expect(deps.backendFetch).toBe(backendFetch);
		expect(deps.projectPath("p1")).toBe("/home/me/proj");
		expect(deps.projectPath("p2")).toBeUndefined();
	});
});
