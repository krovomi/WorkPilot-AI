/**
 * The API Explorer's handlers check what the renderer sends before acting
 * on it: the request the main sends for it, and the scope and values of the
 * secrets it keeps.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	fetch: vi.fn(),
	userData: "",
}));

vi.mock("electron", () => ({
	app: { getPath: () => electron.userData },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			electron.handlers.set(channel, fn),
	},
	net: { fetch: electron.fetch },
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (value: string) => Buffer.from(`enc:${value}`),
		decryptString: (value: Buffer) => value.toString().slice(4),
	},
}));

import { IPC_CHANNELS } from "../../../shared/constants";
import {
	readProxyRequest,
	readSecretScope,
	readSecretValues,
} from "../../api-explorer/ipc-args";
import { registerApiExplorerHandlers } from "../api-explorer-handlers";

electron.userData = mkdtempSync(path.join(tmpdir(), "api-explorer-"));
registerApiExplorerHandlers();
afterAll(() => rmSync(electron.userData, { recursive: true, force: true }));

const call = (channel: string, ...args: unknown[]) =>
	electron.handlers.get(channel)?.({}, ...args) as Promise<
		Record<string, unknown>
	>;

const ok = (body: string) => ({
	status: 200,
	statusText: "OK",
	headers: new Headers({ "content-type": "application/json" }),
	text: async () => body,
});

beforeEach(() => {
	electron.fetch.mockReset();
});

describe("readProxyRequest", () => {
	it("takes an http or https request and upper-cases its method", () => {
		expect(
			readProxyRequest({
				url: "http://localhost:3000/api/users?page=2",
				method: "post",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
		).toEqual({
			url: "http://localhost:3000/api/users?page=2",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(
			readProxyRequest({ url: "https://api.example.com", method: "GET", headers: {} })
				.body,
		).toBeUndefined();
	});

	it.each([
		["a local file", { url: "file:///etc/hosts" }],
		["another scheme", { url: "ftp://example.com/a" }],
		["no address", { url: "not a url" }],
		["a method it does not know", { method: "TRACE" }],
		["a header name with a line break", { headers: { "X-A\r\nB": "1" } }],
		["a header value that is not text", { headers: { "X-A": 1 } }],
		["a body that is not text", { body: { a: 1 } }],
		["a field it does not know", { proxy: "http://elsewhere" }],
	])("refuses %s", (_label, over) => {
		expect(() =>
			readProxyRequest({
				url: "http://localhost:3000/",
				method: "GET",
				headers: {},
				...over,
			}),
		).toThrow();
	});

	it("refuses a request that is not an object", () => {
		expect(() => readProxyRequest("http://localhost")).toThrow();
		expect(() => readProxyRequest(null)).toThrow();
	});
});

describe("readSecretScope and readSecretValues", () => {
	it("takes the scopes the explorer names", () => {
		expect(readSecretScope("request:p1:GET:/users/{id}")).toBe(
			"request:p1:GET:/users/{id}",
		);
		expect(readSecretScope("environment:p1:env-1")).toBe(
			"environment:p1:env-1",
		);
	});

	it.each(["__proto__", "settings", "request:", "request:p1\nGET", "", 42])(
		"refuses the scope %s",
		(scope) => {
			expect(() => readSecretScope(scope)).toThrow();
		},
	);

	it("takes the known secret fields and refuses anything else", () => {
		expect(readSecretValues({ bearer: "b", environmentToken: "t" })).toEqual({
			bearer: "b",
			environmentToken: "t",
		});
		expect(() => readSecretValues({ bearer: 1 })).toThrow();
		expect(() => readSecretValues({ apiKey: "x" })).toThrow();
		expect(() => readSecretValues("bearer")).toThrow();
	});
});

describe("the proxy handler", () => {
	it("sends a checked request and hands back the answer", async () => {
		electron.fetch.mockResolvedValue(ok('{"id":1}'));

		const answer = await call(IPC_CHANNELS.API_EXPLORER_PROXY_REQUEST, {
			url: "http://localhost:3000/users/1",
			method: "get",
			headers: { Accept: "application/json" },
		});

		expect(electron.fetch).toHaveBeenCalledWith("http://localhost:3000/users/1", {
			method: "GET",
			headers: { Accept: "application/json" },
			body: undefined,
		});
		expect(answer).toMatchObject({
			success: true,
			status: 200,
			body: '{"id":1}',
			headers: { "content-type": "application/json" },
		});
	});

	it("never sends a request it refuses", async () => {
		const answer = await call(IPC_CHANNELS.API_EXPLORER_PROXY_REQUEST, {
			url: "file:///etc/hosts",
			method: "GET",
			headers: {},
		});

		expect(electron.fetch).not.toHaveBeenCalled();
		expect(answer).toMatchObject({ success: false, status: 0 });
	});

	it("names binary content instead of returning it", async () => {
		electron.fetch.mockResolvedValue({
			...ok(""),
			headers: new Headers({ "content-type": "image/png" }),
		});
		const answer = await call(IPC_CHANNELS.API_EXPLORER_PROXY_REQUEST, {
			url: "https://api.example.com/logo",
			method: "GET",
			headers: {},
		});
		expect(answer.body).toBe("[Binary content: image/png]");
	});
});

describe("the secret handlers", () => {
	const file = () => path.join(electron.userData, "api-explorer-secrets.json");

	it("keeps a scope's secrets encrypted and reads them back", async () => {
		const scope = "request:p1:GET:/users";
		expect(
			await call(IPC_CHANNELS.API_EXPLORER_SAVE_SECRETS, scope, {
				bearer: "test-bearer-0000",
			}),
		).toEqual({ success: true });

		expect(readFileSync(file(), "utf8")).not.toContain("test-bearer-0000");
		expect(await call(IPC_CHANNELS.API_EXPLORER_LOAD_SECRETS, scope)).toEqual({
			success: true,
			data: { bearer: "test-bearer-0000" },
		});
	});

	it("refuses a scope or values it does not know, and writes nothing", async () => {
		const before = readFileSync(file(), "utf8");

		expect(
			await call(IPC_CHANNELS.API_EXPLORER_SAVE_SECRETS, "__proto__", {
				bearer: "x",
			}),
		).toMatchObject({ success: false });
		expect(
			await call(IPC_CHANNELS.API_EXPLORER_SAVE_SECRETS, "request:p1:GET:/a", {
				shell: "x",
			}),
		).toMatchObject({ success: false });
		expect(
			await call(IPC_CHANNELS.API_EXPLORER_LOAD_SECRETS, "settings"),
		).toMatchObject({ success: false });

		expect(readFileSync(file(), "utf8")).toBe(before);
	});
});
