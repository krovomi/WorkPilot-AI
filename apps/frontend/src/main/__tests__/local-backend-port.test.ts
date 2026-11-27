/**
 * @vitest-environment node
 *
 * The local backend's port (local-backend-port.ts): 9000, a BACKEND_PORT the
 * user set, or the next free one when another program holds 9000. Real
 * sockets for the probe, a scripted state for the walk.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	chooseLocalBackendPort,
	DEFAULT_LOCAL_BACKEND_PORT,
	FALLBACK_PORT_SPAN,
	isWorkPilotHealth,
	localBackendPort,
	localBackendUrl,
	localPortState,
	type PortState,
	parseBackendPort,
	settleLocalBackendPort,
} from "../local-backend-port";

const servers: Array<{ close: (cb: () => void) => unknown }> = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
	);
});

function listenHttp(status: number, body: string): Promise<number> {
	const server: Server = createHttpServer((_req, res) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(body);
	});
	servers.push(server);
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve((server.address() as AddressInfo).port),
		),
	);
}

function freePort(): Promise<number> {
	const server = createTcpServer();
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		}),
	);
}

/** A scripted state: ports listed as "other" or "workpilot", the rest free. */
function scripted(states: Record<number, PortState>) {
	const asked: number[] = [];
	const state = async (port: number): Promise<PortState> => {
		asked.push(port);
		return states[port] ?? "free";
	};
	return { state, asked };
}

describe("BACKEND_PORT", () => {
	it.each([
		["9001", 9001],
		[" 65535 ", 65535],
		["1024", 1024],
	])("accepts %j", (raw, port) => {
		expect(parseBackendPort(raw)).toBe(port);
	});

	it.each([undefined, "", "80", "1023", "65536", "9000a", "-9000", "9e3", "90000"])(
		"refuses %j",
		(raw) => {
			expect(parseBackendPort(raw)).toBeNull();
		},
	);

	it("is 9000 when unset or not a port", () => {
		expect(localBackendPort({})).toBe(9000);
		expect(localBackendPort({ BACKEND_PORT: "abc" })).toBe(9000);
		expect(localBackendPort({ BACKEND_PORT: "9005" })).toBe(9005);
	});
});

describe("the URL every caller uses", () => {
	it("follows the chosen port, over a development .env URL", () => {
		expect(
			localBackendUrl({
				BACKEND_PORT: "9003",
				VITE_BACKEND_URL: "http://localhost:9000",
			}),
		).toBe("http://127.0.0.1:9003");
	});

	it("keeps the configured URLs when no port was chosen", () => {
		expect(localBackendUrl({ VITE_BACKEND_URL: "http://localhost:9100" })).toBe(
			"http://localhost:9100",
		);
		expect(localBackendUrl({ BACKEND_URL: "http://127.0.0.1:9200" })).toBe(
			"http://127.0.0.1:9200",
		);
		expect(localBackendUrl({})).toBe("http://127.0.0.1:9000");
	});
});

describe("which program holds a port", () => {
	it.each([
		[200, '{"status": "healthy"}', true],
		[200, '{"status": "degraded", "subsystems": {}}', true],
		[200, '{"status": "ok"}', false],
		[200, "null", false],
		[200, "<html>", false],
		[503, '{"status": "healthy"}', false],
	])("status %i with %s is a WorkPilot backend: %s", (status, body, expected) => {
		expect(isWorkPilotHealth(status, body)).toBe(expected);
	});

	it("finds a free port free", async () => {
		expect(await localPortState(await freePort())).toBe("free");
	});

	it("recognises a WorkPilot backend", async () => {
		const port = await listenHttp(200, '{"status": "healthy"}');
		expect(await localPortState(port)).toBe("workpilot");
	});

	it("names anything else other", async () => {
		const port = await listenHttp(404, '{"detail": "Not Found"}');
		expect(await localPortState(port)).toBe("other");
	});

	it("does not read an endless answer", async () => {
		const port = await listenHttp(200, `{"status": "healthy", "x": "${"a".repeat(70_000)}"}`);
		expect(await localPortState(port)).toBe("other");
	});

	it("treats a port that accepts and never answers as other", async () => {
		const server = createTcpServer(() => undefined);
		servers.push({
			close: (cb) => {
				server.close(cb);
				return undefined;
			},
		});
		const port = await new Promise<number>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
		);
		// Destroy accepted sockets so close() returns once the probe gave up.
		server.on("connection", (socket) => setTimeout(() => socket.destroy(), 2_000));
		expect(await localPortState(port)).toBe("other");
	}, 10_000);
});

describe("choosing the port of this run", () => {
	it("keeps BACKEND_PORT as set, without looking", async () => {
		const { state, asked } = scripted({});
		expect(await chooseLocalBackendPort({ BACKEND_PORT: "9100" }, state)).toEqual({
			port: 9100,
		});
		expect(asked).toEqual([]);
	});

	it("uses 9000 when it is free or serves a WorkPilot backend", async () => {
		expect(await chooseLocalBackendPort({}, scripted({}).state)).toEqual({ port: 9000 });
		expect(
			await chooseLocalBackendPort({}, scripted({ 9000: "workpilot" }).state),
		).toEqual({ port: 9000 });
	});

	it("moves to the next port that is free or serves a WorkPilot backend", async () => {
		const { state, asked } = scripted({ 9000: "other", 9001: "other" });
		expect(await chooseLocalBackendPort({}, state)).toEqual({
			port: 9002,
			movedFrom: 9000,
		});
		expect(asked).toEqual([9000, 9001, 9002]);

		const reuse = scripted({ 9000: "other", 9001: "workpilot" });
		expect(await chooseLocalBackendPort({}, reuse.state)).toEqual({
			port: 9001,
			movedFrom: 9000,
		});
	});

	it("gives up after the span", async () => {
		const states: Record<number, PortState> = {};
		for (let p = 9000; p <= 9000 + FALLBACK_PORT_SPAN; p++) states[p] = "other";
		const { state, asked } = scripted(states);
		expect(await chooseLocalBackendPort({}, state)).toBeNull();
		expect(asked).toHaveLength(FALLBACK_PORT_SPAN + 1);
	});

	it("records the choice for every caller and for the backend it spawns", async () => {
		const env: NodeJS.ProcessEnv = {};
		await settleLocalBackendPort(env, scripted({ 9000: "other" }).state);
		expect(env.BACKEND_PORT).toBe("9001");
		expect(localBackendUrl(env)).toBe("http://127.0.0.1:9001");
	});

	it("leaves the default when nothing is free, so the launch names the holder", async () => {
		const states: Record<number, PortState> = {};
		for (let p = 9000; p <= 9000 + FALLBACK_PORT_SPAN; p++) states[p] = "other";
		const env: NodeJS.ProcessEnv = {};
		expect(await settleLocalBackendPort(env, scripted(states).state)).toBeNull();
		expect(env.BACKEND_PORT).toBe(String(DEFAULT_LOCAL_BACKEND_PORT));
	});

	it("needs no scripted state", async () => {
		const env: NodeJS.ProcessEnv = { BACKEND_PORT: String(await freePort()) };
		expect(await settleLocalBackendPort(env)).toEqual({ port: Number(env.BACKEND_PORT) });
	});
});
