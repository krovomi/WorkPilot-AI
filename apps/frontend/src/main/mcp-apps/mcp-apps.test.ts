import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMcpAppViewEvent } from "../ipc-handlers/task/mcp-app-handlers";
import { buildViewCsp, withCspMeta } from "./view-csp";
import {
	_resetMcpAppViews,
	closeMcpAppView,
	closeMcpAppViewsOf,
	isMcpAppFrameNavigationAllowed,
	openMcpAppView,
	serveMcpAppRequest,
} from "./view-protocol";
import { listMcpAppViews, type McpAppViewFile, readMcpAppView } from "./view-store";

const ID_A = "0123456789abcdef";
const ID_B = "fedcba9876543210";

function view(viewId: string, extra: Partial<McpAppViewFile> = {}): McpAppViewFile {
	return {
		viewId,
		server: "weather",
		tool: "forecast",
		resourceUri: "ui://weather/view.html",
		html: "<!doctype html><p>view</p>",
		ui: {},
		toolInput: { city: "Paris" },
		toolResult: { content: [{ type: "text", text: "sunny" }] },
		createdAt: 1000,
		...extra,
	};
}

describe("view-store", () => {
	let root: string;
	let spec: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "mcp-apps-"));
		spec = path.join(root, "spec");
		mkdirSync(path.join(spec, "mcp-apps"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const write = (dir: string, name: string, body: unknown) =>
		writeFileSync(path.join(dir, "mcp-apps", name), typeof body === "string" ? body : JSON.stringify(body));

	it("lists the views newest first, once each, without their HTML", () => {
		const worktree = path.join(root, "wt");
		mkdirSync(path.join(worktree, "mcp-apps"), { recursive: true });
		write(spec, `${ID_A}.json`, view(ID_A, { createdAt: 1 }));
		write(spec, `${ID_B}.json`, view(ID_B, { createdAt: 2 }));
		write(worktree, `${ID_A}.json`, view(ID_A, { createdAt: 1 }));
		const listed = listMcpAppViews([spec, worktree]);
		expect(listed.map((v) => v.viewId)).toEqual([ID_B, ID_A]);
		expect(listed[0]).toEqual({ viewId: ID_B, server: "weather", tool: "forecast", createdAt: 2 });
	});

	it("skips what is not a view the backend wrote", () => {
		write(spec, "notes.json", view(ID_A));
		write(spec, `${ID_A}.json`, "{not json");
		write(spec, `${ID_B}.json`, view(ID_A)); // the id inside does not match the name
		write(spec, "aaaaaaaaaaaaaaaa.json", { ...view("aaaaaaaaaaaaaaaa"), resourceUri: "https://x" });
		expect(listMcpAppViews([spec])).toEqual([]);
	});

	it("reads a view by its id only", () => {
		write(spec, `${ID_A}.json`, view(ID_A));
		expect(readMcpAppView([spec], ID_A)?.html).toContain("<p>view</p>");
		for (const bad of ["../spec/x", `${ID_A}.json`, "ABCDEF0123456789", 42, undefined]) {
			expect(readMcpAppView([spec], bad)).toBeNull();
		}
	});

	it("does not follow a linked views folder out of the spec directory", () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		writeFileSync(path.join(outside, `${ID_A}.json`), JSON.stringify(view(ID_A)));
		const linked = path.join(root, "linked");
		mkdirSync(linked);
		// A junction needs no privilege on Windows; elsewhere the type is ignored.
		symlinkSync(outside, path.join(linked, "mcp-apps"), "junction");
		expect(readMcpAppView([linked], ID_A)).toBeNull();
		expect(listMcpAppViews([linked])).toEqual([]);
	});

	it("does not follow a linked view file", () => {
		const outside = path.join(root, `${ID_A}.json`);
		writeFileSync(outside, JSON.stringify(view(ID_A)));
		try {
			symlinkSync(outside, path.join(spec, "mcp-apps", `${ID_A}.json`), "file");
		} catch {
			return; // file symlinks need privileges on some Windows runners
		}
		expect(readMcpAppView([spec], ID_A)).toBeNull();
		expect(listMcpAppViews([spec])).toEqual([]);
	});

	it("keeps the declared CSP and drops a malformed ui block", () => {
		write(spec, `${ID_A}.json`, view(ID_A, { ui: { csp: { connectDomains: ["https://a.example"] } } }));
		write(spec, `${ID_B}.json`, { ...view(ID_B), ui: "nope" });
		expect(readMcpAppView([spec], ID_A)?.ui.csp?.connectDomains).toEqual(["https://a.example"]);
		expect(readMcpAppView([spec], ID_B)?.ui).toEqual({});
	});
});

describe("view-csp", () => {
	it("reaches nothing outside the view without a declaration", () => {
		const csp = buildViewCsp({});
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain("https:");
	});

	it("allows exactly the declared https origins", () => {
		const csp = buildViewCsp({
			csp: {
				connectDomains: ["https://api.weather.example", "wss://live.weather.example"],
				resourceDomains: ["https://*.cdn.example/"],
				frameDomains: ["https://maps.example:8443"],
			},
		});
		expect(csp).toContain("connect-src https://api.weather.example wss://live.weather.example");
		expect(csp).toContain("script-src 'self' 'unsafe-inline' https://*.cdn.example");
		expect(csp).toContain("frame-src https://maps.example:8443");
	});

	it("drops anything that is not a bare https origin", () => {
		const hostile = [
			"*",
			"https:",
			"http://plain.example",
			"data:",
			"'unsafe-eval'",
			"https://a.example 'unsafe-eval'",
			"https://a.example; script-src *",
			'https://a.example" onload="x',
			"https://a.example/path",
			"wss://only-for-connect.example",
			"javascript:alert(1)",
		];
		const csp = buildViewCsp({ csp: { resourceDomains: hostile, frameDomains: hostile, baseUriDomains: hostile } });
		expect(csp).not.toMatch(/unsafe-eval|http:|data:\s*https|\*;|javascript|path|onload|wss:/);
		expect(csp).toContain("frame-src 'none'");
		expect(csp.split("; ").filter((d) => d.startsWith("script-src"))).toEqual([
			"script-src 'self' 'unsafe-inline'",
		]);
	});

	it("puts the policy at the top of the document, after a doctype", () => {
		expect(withCspMeta("<!DOCTYPE html><p>x</p>", "default-src 'none'")).toBe(
			`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>x</p>`,
		);
		expect(withCspMeta("<p>x</p>", "a")).toBe(`<meta http-equiv="Content-Security-Policy" content="a"><p>x</p>`);
	});
});

describe("view-protocol", () => {
	afterEach(() => _resetMcpAppViews());

	it("serves an open view with its own policy, and nothing else", () => {
		const { token, url } = openMcpAppView("task-1", view(ID_A));
		expect(url).toBe(`workpilot-mcp-app://${token}/`);
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		const served = serveMcpAppRequest("GET", url);
		expect(served.status).toBe(200);
		expect(served.headers["Content-Security-Policy"]).toContain("default-src 'none'");
		expect(served.body).toContain('<meta http-equiv="Content-Security-Policy"');
		expect(served.body).toContain("<p>view</p>");

		for (const [method, other] of [
			["POST", url],
			["GET", `${url}other.js`],
			["GET", `${url}?x=1`],
			["GET", "workpilot-mcp-app://0000/"],
			["GET", `https://${token}/`],
			["GET", "not a url"],
		]) {
			expect(serveMcpAppRequest(method, other).status).toBe(404);
		}
	});

	it("stops serving a view once it is closed", () => {
		const a = openMcpAppView("task-1", view(ID_A));
		const b = openMcpAppView("task-2", view(ID_B));
		expect(closeMcpAppView(a.token)).toBe(true);
		expect(serveMcpAppRequest("GET", a.url).status).toBe(404);
		closeMcpAppViewsOf("task-2");
		expect(serveMcpAppRequest("GET", b.url).status).toBe(404);
		expect(closeMcpAppView(42)).toBe(false);
	});

	it("keeps a bounded number of views open", () => {
		const first = openMcpAppView("t", view(ID_A));
		for (let i = 0; i < 16; i++) openMcpAppView("t", view(ID_B));
		expect(serveMcpAppRequest("GET", first.url).status).toBe(404);
	});

	it("keeps a frame showing a view on that view", () => {
		const from = "workpilot-mcp-app://abc/";
		expect(isMcpAppFrameNavigationAllowed(from, "workpilot-mcp-app://abc/")).toBe(true);
		expect(isMcpAppFrameNavigationAllowed(from, "https://evil.example/?leak=1")).toBe(false);
		expect(isMcpAppFrameNavigationAllowed(from, "workpilot-mcp-app://other/")).toBe(false);
		expect(isMcpAppFrameNavigationAllowed(from, "workpilot-mcp-app://abc/x")).toBe(false);
		// The app's own frames are not this policy's business.
		expect(isMcpAppFrameNavigationAllowed("https://docs.example/", "https://x.example/")).toBe(true);
		expect(isMcpAppFrameNavigationAllowed(undefined, "workpilot-mcp-app://abc/")).toBe(true);
	});
});

describe("MCP_APP_VIEW event", () => {
	it("is forwarded only when well formed", () => {
		expect(
			parseMcpAppViewEvent({ type: "MCP_APP_VIEW", mcpApp: { viewId: ID_A, server: "s", tool: "t" } }),
		).toEqual({ viewId: ID_A, server: "s", tool: "t" });
		expect(parseMcpAppViewEvent({ mcpApp: { viewId: "../x", server: "s", tool: "t" } })).toBeNull();
		expect(parseMcpAppViewEvent({ mcpApp: { viewId: ID_A, server: "", tool: "t" } })).toBeNull();
		expect(parseMcpAppViewEvent({})).toBeNull();
	});
});
