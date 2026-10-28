import { describe, expect, it, vi } from "vitest";
import { createMcpAppBridge, MAX_VIEW_HEIGHT, MIN_VIEW_HEIGHT } from "./mcp-app-bridge";

function setup() {
	const posted: Record<string, unknown>[] = [];
	const onHeight = vi.fn();
	const bridge = createMcpAppBridge({
		post: (message) => posted.push(message),
		toolInput: { city: "Paris" },
		toolResult: { content: [{ type: "text", text: "sunny" }] },
		hostVersion: () => "3.0.0",
		context: () => ({ theme: "dark", locale: "fr", containerWidth: 640 }),
		onHeight,
	});
	return { bridge, posted, onHeight };
}

const request = (id: number, method: string, params: Record<string, unknown> = {}) => ({
	jsonrpc: "2.0",
	id,
	method,
	params,
});
const notification = (method: string, params: Record<string, unknown> = {}) => ({
	jsonrpc: "2.0",
	method,
	params,
});

describe("MCP Apps host bridge", () => {
	it("initializes, then sends the call once the view is ready", () => {
		const { bridge, posted } = setup();
		bridge.receive(request(1, "ui/initialize", { protocolVersion: "2026-01-26" }));
		expect(posted).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				result: {
					protocolVersion: "2026-01-26",
					hostCapabilities: {},
					hostInfo: { name: "WorkPilot AI", version: "3.0.0" },
					hostContext: {
						theme: "dark",
						displayMode: "inline",
						availableDisplayModes: ["inline"],
						containerDimensions: { width: 640, maxHeight: MAX_VIEW_HEIGHT },
						locale: "fr",
						platform: "desktop",
					},
				},
			},
		]);
		bridge.receive(notification("ui/notifications/initialized"));
		bridge.receive(notification("ui/notifications/initialized"));
		expect(posted.slice(1)).toEqual([
			notification("ui/notifications/tool-input", { arguments: { city: "Paris" } }),
			notification("ui/notifications/tool-result", { content: [{ type: "text", text: "sunny" }] }),
		]);
	});

	it("sends nothing before ui/initialize", () => {
		const { bridge, posted } = setup();
		bridge.receive(notification("ui/notifications/initialized"));
		expect(posted).toEqual([]);
		expect(bridge.initialized).toBe(false);
	});

	it.each([
		"tools/call",
		"resources/read",
		"ui/message",
		"ui/open-link",
		"ui/update-model-context",
		"anything/else",
	])("refuses %s", (method) => {
		const { bridge, posted } = setup();
		bridge.receive(request(7, method, { name: "delete_everything" }));
		expect(posted).toEqual([
			{
				jsonrpc: "2.0",
				id: 7,
				error: { code: -32601, message: `${method} is not available in this host` },
			},
		]);
	});

	it("answers ping and keeps the view inline", () => {
		const { bridge, posted } = setup();
		bridge.receive(request(2, "ping"));
		bridge.receive(request(3, "ui/request-display-mode", { mode: "fullscreen" }));
		expect(posted).toEqual([
			{ jsonrpc: "2.0", id: 2, result: {} },
			{ jsonrpc: "2.0", id: 3, result: { mode: "inline" } },
		]);
	});

	it("follows the view's height within bounds", () => {
		const { bridge, onHeight } = setup();
		bridge.receive(notification("ui/notifications/size-changed", { height: 420.4 }));
		bridge.receive(notification("ui/notifications/size-changed", { height: 1e9 }));
		bridge.receive(notification("ui/notifications/size-changed", { height: -5 }));
		bridge.receive(notification("ui/notifications/size-changed", { height: "big" }));
		expect(onHeight.mock.calls).toEqual([[420], [MAX_VIEW_HEIGHT], [MIN_VIEW_HEIGHT]]);
	});

	it("ignores what is not JSON-RPC 2.0", () => {
		const { bridge, posted } = setup();
		for (const data of [null, "ui/initialize", { method: "ui/initialize", id: 1 }, { jsonrpc: "2.0", id: 1 }]) {
			bridge.receive(data);
		}
		expect(posted).toEqual([]);
	});

	it("tells an initialized view it is going away", () => {
		const { bridge, posted } = setup();
		bridge.teardown();
		expect(posted).toEqual([]);
		bridge.receive(request(1, "ui/initialize"));
		bridge.teardown();
		expect(posted.at(-1)).toMatchObject({ jsonrpc: "2.0", method: "ui/resource-teardown", params: {} });
	});
});
