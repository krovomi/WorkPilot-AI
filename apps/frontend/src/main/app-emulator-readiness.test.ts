// @vitest-environment node
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AppEmulatorService } from "./app-emulator-service";
vi.mock("electron", () => ({
	app: { getAppPath: () => process.cwd(), isPackaged: false },
}));
afterEach(() => vi.restoreAllMocks());

it("rejects readiness when the HTTP server continues returning 503", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(503);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const service = new AppEmulatorService();
	const runtime = service as unknown as {
		activeServerProcess: { killed: boolean };
		waitForHttpSuccess(port: number, timeout: number): Promise<boolean>;
	};
	runtime.activeServerProcess = { killed: false };
	try {
		await expect(runtime.waitForHttpSuccess(address.port, 50)).rejects.toThrow(
			/HTTP/,
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("accepts an HTTP authentication response as a reachable server", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(401);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const runtime = new AppEmulatorService() as unknown as {
		activeServerProcess: { killed: boolean };
		waitForHttpSuccess(port: number, timeout: number): Promise<boolean>;
	};
	runtime.activeServerProcess = { killed: false };
	try {
		await expect(runtime.waitForHttpSuccess(address.port, 1000)).resolves.toBe(
			true,
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("cancels readiness quietly after the server is stopped", async () => {
	const runtime = new AppEmulatorService() as unknown as {
		activeServerProcess: null;
		waitForHttpSuccess(port: number, timeout: number): Promise<boolean>;
	};
	runtime.activeServerProcess = null;
	await expect(runtime.waitForHttpSuccess(5000, 100)).resolves.toBe(false);
});
