/**
 * App Emulator server lifecycle: install, spawn, port conflicts, readiness,
 * stop. The dev servers are fake processes that open real HTTP servers.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppEmulatorConfig, AppEmulatorService } from "../app-emulator-service";
import {
	addFiles,
	cleanWorld,
	drive,
	freePort,
	httpServer,
	pkg,
	project,
	realPause,
	resetWorld,
	silentListener,
	spawnsOf,
	startsHttpServer,
	world,
} from "./app-emulator-world";

vi.mock("node:child_process", async () =>
	(await import("./app-emulator-world")).childProcessModule(),
);
vi.mock("../platform", async () => (await import("./app-emulator-world")).platformModule());

interface Recorder {
	events: Array<[string, ...unknown[]]>;
	of(name: string): unknown[];
}

function record(service: AppEmulatorService): Recorder {
	const events: Recorder["events"] = [];
	for (const name of ["status", "ready", "output", "error", "stopped", "config"]) {
		service.on(name, (...args: unknown[]) => events.push([name, ...args]));
	}
	return {
		events,
		of: (name) => events.filter(([event]) => event === name).map(([, value]) => value),
	};
}

function nodeProject(extra: Record<string, string> = {}, name = "web"): string {
	return project(
		{ "package.json": pkg({ scripts: { dev: "vite" } }), "node_modules/": "", ...extra },
		name,
	);
}

function webConfig(projectDir: string, port: number, extra: Partial<AppEmulatorConfig> = {}) {
	return {
		type: "web",
		framework: "vite",
		startCommand: "npm run dev",
		port,
		isWeb: true,
		projectDir,
		...extra,
	} satisfies AppEmulatorConfig;
}

let service: AppEmulatorService;
let seen: Recorder;

beforeEach(() => {
	resetWorld();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	service = new AppEmulatorService();
	seen = record(service);
});

afterEach(async () => {
	service.removeAllListeners();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await cleanWorld();
});

describe("startServer — one service", () => {
	it("starts the dev server without credentials and reports it ready", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-0000");
		const dir = nodeProject();
		const port = await freePort();
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(webConfig(dir, port)));

		const [call] = world.spawns;
		expect([call.cmd, call.args]).toEqual(["npm", ["run", "dev"]]);
		expect(call.options.cwd).toBe(dir);
		expect(call.options.shell).toBeUndefined();
		expect(call.options.env).toMatchObject({ BROWSER: "none", PORT: String(port) });
		expect(call.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(seen.of("status")).toContain("Starting: npm run dev");
		expect(seen.of("ready")).toEqual([`http://localhost:${port}`]);
		expect(service.isRunning()).toBe(true);
		expect(service.getUrl()).toBe(`http://localhost:${port}`);
		expect(service.getConfig()?.port).toBe(port);
	});

	it("forwards the server output, line by line", async () => {
		const dir = nodeProject();
		world.onSpawn = (call) =>
			setImmediate(() => {
				call.proc.print("  VITE ready\n\nlocal: x\n");
				call.proc.print("warn: y\n", "stderr");
			});

		await drive(service.startServer({ ...webConfig(dir, 0), isWeb: false }));
		await realPause();

		expect(seen.of("output")).toEqual(["  VITE ready", "local: x", "warn: y"]);
	});

	it("stops the server it started", async () => {
		const dir = nodeProject();
		const port = await freePort();
		world.onSpawn = startsHttpServer();
		await drive(service.startServer(webConfig(dir, port)));
		const [{ proc }] = world.spawns;
		seen.events.length = 0;

		service.stopServer();
		await realPause();

		expect(proc.killSignals).toEqual(["SIGKILL"]);
		expect(seen.of("stopped").length).toBeGreaterThan(0);
		expect(seen.of("error")).toEqual([]);
		expect(service.isRunning()).toBe(false);
		expect(service.getUrl()).toBeNull();
		expect(service.getConfig()).toBeNull();
	});

	it("ignores a second start while the first is under way", async () => {
		const dir = nodeProject();
		world.onSpawn = () => undefined;
		const config = { ...webConfig(dir, 0), isWeb: false };

		const first = service.startServer(config);
		await service.startServer(config);
		await drive(first);

		expect(world.spawns).toHaveLength(1);
	});

	it("starts nothing once stopped, even while it was waiting or installing", async () => {
		const config = { ...webConfig(nodeProject(), 0), isWeb: false };
		const waiting = service.startServer(config);
		service.stopServer();
		await drive(waiting);

		const dir = project({ "package.json": pkg({ scripts: { dev: "x" } }) });
		world.onSpawn = (call) => {
			if (call.args[0] === "install") setTimeout(() => call.proc.exit(0), 5000);
		};
		const installing = service.startServer({ ...config, projectDir: dir });
		await vi.advanceTimersByTimeAsync(2000);
		service.stopServer();
		await drive(installing);

		expect(world.spawns.map((call) => call.args)).toEqual([["install"]]);
		expect(service.isRunning()).toBe(false);

		await drive(service.startServer(config));
		expect(world.spawns).toHaveLength(2);
	});

	it("refuses a configuration without a command", async () => {
		await drive(service.startServer({ ...webConfig(nodeProject(), 0), startCommand: "" }));

		expect(seen.of("error")).toEqual(["No start command configured"]);
		expect(world.spawns).toEqual([]);
	});

	it("runs from the current folder when the configuration names none", async () => {
		world.onSpawn = () => undefined;

		await drive(
			service.startServer({
				type: "cli",
				framework: "rust",
				startCommand: "cargo run",
				port: 0,
				isWeb: false,
			}),
		);

		expect(world.spawns[0].options.cwd).toBe(process.cwd());
	});

	it("passes a command with shell syntax to the shell", async () => {
		const dir = nodeProject();
		world.onSpawn = () => undefined;

		await drive(
			service.startServer({ ...webConfig(dir, 0), isWeb: false, startCommand: "a && b" }),
		);
		await drive(
			service.startServer({
				...webConfig(dir, 0),
				isWeb: false,
				startCommand: "sh -lc echo",
			}),
		);

		expect(world.spawns.map((call) => [call.cmd, call.args, call.options.shell])).toEqual([
			["a && b", [], true],
			["sh -lc echo", [], true],
		]);
	});
});

describe("startServer — dependencies", () => {
	it("installs the Node dependencies first, with the project's package manager", async () => {
		const dir = project({ "package.json": pkg({ scripts: { dev: "x" } }), "pnpm-lock.yaml": "" });
		world.onSpawn = (call) => {
			if (call.args[0] !== "install") return;
			setImmediate(() => {
				call.proc.print("Packages: +12\n");
				call.proc.print("WARN peer\n", "stderr");
				call.proc.exit(0);
			});
		};

		await drive(service.startServer({ ...webConfig(dir, 0), isWeb: false }));

		expect(world.spawns.map((call) => [call.cmd, call.args])).toEqual([
			["pnpm", ["install"]],
			["npm", ["run", "dev"]],
		]);
		expect(world.spawns[0].options.cwd).toBe(dir);
		expect(seen.of("status")).toContain("Installing dependencies with pnpm...");
		expect(seen.of("output")).toEqual([
			'node_modules not found — running "pnpm install"...',
			"Packages: +12",
			"WARN peer",
			"Dependencies installed successfully.",
		]);
	});

	it("does not start a server whose install failed", async () => {
		const dir = project({ "package.json": pkg({}) });
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(3));

		await drive(service.startServer({ ...webConfig(dir, 0), isWeb: false }));

		expect(seen.of("error")).toEqual(['Error: "npm install" exited with code 3']);
		expect(world.spawns).toHaveLength(1);
	});

	it("reports an installer that cannot start", async () => {
		const dir = project({ "package.json": pkg({}) });
		world.onSpawn = (call) => setImmediate(() => call.proc.fail("spawn npm ENOENT"));

		await drive(service.startServer({ ...webConfig(dir, 0), isWeb: false }));

		expect(seen.of("error")).toEqual([
			'Error: Failed to run "npm install": spawn npm ENOENT',
		]);
	});

	it.each([
		[{ "poetry.lock": "", "requirements.txt": "" }, "poetry", ["install"]],
		[{ "uv.lock": "" }, "uv", ["sync"]],
		[{ "Pipfile.lock": "" }, "pipenv", ["install"]],
		[{ "requirements.txt": "flask" }, "pip", ["install", "-r", "requirements.txt"]],
		[{ "pyproject.toml": "" }, "pip", ["install", "-e", "."]],
	])("installs the Python dependencies of %o", async (files, cmd, args) => {
		const dir = project({ "main.py": "", ...files });
		world.onSpawn = (call) => {
			if (call.cmd === "python") return;
			setImmediate(() => {
				call.proc.print("Collecting x\n");
				call.proc.print("notice\n", "stderr");
				call.proc.exit(0);
			});
		};
		const config = {
			type: "cli",
			framework: "python",
			startCommand: "python main.py",
			port: 0,
			isWeb: false,
			projectDir: dir,
		};

		await drive(service.startServer(config));

		expect(world.spawns.map((call) => [call.cmd, call.args])).toEqual([
			[cmd, args],
			["python", ["main.py"]],
		]);
		expect(seen.of("status")).toContain("Installing Python dependencies...");
		expect(seen.of("output")).toEqual([
			`No virtual environment found — running "${[cmd, ...args].join(" ")}"...`,
			"Collecting x",
			"notice",
			"Python dependencies installed successfully.",
		]);
	});

	it.each([
		[{ ".venv/lib/": "", "requirements.txt": "" }],
		[{ "venv/Lib/": "", "requirements.txt": "" }],
		[{}],
	])("installs nothing for %o", async (files) => {
		const dir = project({ "main.py": "", ...files });
		world.onSpawn = () => undefined;

		await drive(
			service.startServer({
				type: "web",
				framework: "flask",
				startCommand: "python main.py",
				port: 0,
				isWeb: false,
				projectDir: dir,
			}),
		);

		expect(world.spawns.map((call) => call.cmd)).toEqual(["python"]);
	});

	it.each([
		[(call: { proc: { exit(code: number): void } }) => call.proc.exit(1), '"pip install -r requirements.txt" exited with code 1'],
		[
			(call: { proc: { fail(message: string): void } }) => call.proc.fail("no pip"),
			'Failed to run "pip install -r requirements.txt": no pip',
		],
	])("does not start a Python server whose install failed", async (outcome, message) => {
		const dir = project({ "app.py": "", "requirements.txt": "django" });
		world.onSpawn = (call) => setImmediate(() => outcome(call));

		await drive(
			service.startServer({
				type: "web",
				framework: "django",
				startCommand: "python manage.py runserver",
				port: 0,
				isWeb: false,
				projectDir: dir,
			}),
		);

		expect(seen.of("error")).toEqual([`Error: ${message}`]);
		expect(world.spawns).toHaveLength(1);
	});
});

describe("startServer — ports", () => {
	it("reuses a server already answering on the port", async () => {
		const port = await freePort();
		await httpServer(port);

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(world.spawns).toEqual([]);
		expect(seen.of("ready")).toEqual([`http://localhost:${port}`]);
		expect(seen.of("status")).toContain(`Running at http://localhost:${port}`);
	});

	it.each([
		["npx vite --port {old}", "npx vite --port {new}", "vite"],
		["PORT={old} node server.js", "PORT={new} node server.js", "express"],
		["iisexpress /port:{old}", "iisexpress /port:{new}", "dotnet-framework-iis-express"],
		["npm run dev", "npm run dev -- --port {new}", "vite"],
		["ng serve", "npx ng serve --port {new}", "angular"],
	])("moves %s to the next free port when the port is held", async (command, expected, framework) => {
		const port = await freePort();
		await silentListener(port);
		world.onSpawn = () => undefined;
		const config = webConfig(nodeProject(), port, {
			framework,
			startCommand: command.replace("{old}", String(port)),
			isWeb: true,
		});
		// The run is cut short once the command is spawned.
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(0));

		await drive(service.startServer(config));

		const [moved] = seen.of("config") as AppEmulatorConfig[];
		expect(moved.port).toBeGreaterThan(port);
		expect(moved.startCommand).toBe(
			expected.replace("{old}", String(port)).replace("{new}", String(moved.port)),
		);
		expect(seen.of("status")).toContain(`Port ${port} in use — using port ${moved.port} instead`);
		expect(world.spawns[0].options.env?.PORT).toBe(String(moved.port));
	});

	it("keeps the port when every following port is taken", async () => {
		const port = await freePort();
		await Promise.all(
			Array.from({ length: 21 }, (_, offset) => silentListener(port + offset).catch(() => undefined)),
		);
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(0));

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("status")).toContain(`Port ${port} in use — using port ${port + 1} instead`);
	});
});

describe("startServer — readiness", () => {
	it("waits for an HTTP answer below 500 before calling the server ready", async () => {
		const port = await freePort();
		let calls = 0;
		world.onSpawn = startsHttpServer(() => (++calls < 3 ? 503 : 401));

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(calls).toBe(3);
		expect(seen.of("ready")).toEqual([`http://localhost:${port}`]);
	});

	it("waits for the port to open", async () => {
		const port = await freePort();
		world.onSpawn = (call) => {
			setTimeout(() => void httpServer(Number(call.options.env?.PORT)), 3000);
		};

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("ready")).toEqual([`http://localhost:${port}`]);
	});

	it("gives up on a server that never answers", async () => {
		const port = await freePort();
		world.onSpawn = startsHttpServer(500);

		await expect(drive(service.startServer(webConfig(nodeProject(), port)))).rejects.toThrow(
			`HTTP server on port ${port} did not become ready before the timeout. Check the server output.`,
		);
		expect(seen.of("ready")).toEqual([]);
	});

	it("gives up on a server that never listens", async () => {
		const port = await freePort();
		world.onSpawn = () => undefined;

		await expect(drive(service.startServer(webConfig(nodeProject(), port)))).rejects.toThrow(
			"did not become ready",
		);
	});

	it("reports a server that exits, with the lines that explain why", async () => {
		const port = await freePort();
		world.onSpawn = (call) =>
			setImmediate(() => {
				call.proc.print("compiling\nerror TS2304: Cannot find name 'x'\n");
				call.proc.exit(1);
			});

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("error")).toEqual([
			"Server exited with code 1\n\nerror TS2304: Cannot find name 'x'",
		]);
		expect(seen.of("ready")).toEqual([]);
		expect(service.isRunning()).toBe(false);
	});

	it("keeps the last 200 lines to explain an exit", async () => {
		const port = await freePort();
		world.onSpawn = (call) =>
			setImmediate(() => {
				for (let index = 0; index < 205; index++) call.proc.print(`line ${index}\n`);
				call.proc.exit(2);
			});

		await drive(service.startServer(webConfig(nodeProject(), port)));

		const [message] = seen.of("error") as string[];
		expect(message).toContain("line 204");
		expect(message).not.toContain("line 4\n");
	});

	it("gives up quietly on a server that dies as the wait times out", async () => {
		const port = await freePort();
		world.onSpawn = (call) => setTimeout(() => call.proc.exit(null), 60_300);

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("ready")).toEqual([]);
		expect(seen.of("error")).toEqual([]);
	});

	it("moves off a port whose holder accepts but never answers", async () => {
		const port = await freePort();
		const { createServer } = await import("node:http");
		const hanging = createServer(() => undefined);
		world.servers.add(hanging);
		await new Promise<void>((resolve) => hanging.listen(port, resolve));
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(0));

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect((seen.of("config")[0] as AppEmulatorConfig).port).toBeGreaterThan(port);
	});

	it("drops a server that exits once it is listening", async () => {
		const port = await freePort();
		world.onSpawn = (call) => {
			void httpServer(Number(call.options.env?.PORT), 503);
			setTimeout(() => call.proc.exit(0), 1500);
		};

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("ready")).toEqual([]);
		expect(seen.of("error")).toEqual([]);
	});

	it("reports a server that cannot start", async () => {
		const port = await freePort();
		world.onSpawn = (call) => setImmediate(() => call.proc.fail("spawn npm ENOENT"));

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(seen.of("error")).toEqual(["Failed to start server: spawn npm ENOENT"]);
		expect(service.isRunning()).toBe(false);
	});

	it("ignores the late exit of the server it replaced", async () => {
		const dir = nodeProject();
		const first = await freePort();
		world.onSpawn = startsHttpServer();
		await drive(service.startServer(webConfig(dir, first)));
		const [old] = world.spawns;
		old.proc.exitOnKill = false;

		const second = await freePort();
		await drive(service.startServer(webConfig(dir, second)));
		seen.events.length = 0;
		old.proc.fail("late");
		old.proc.exit(1);

		expect(service.isRunning()).toBe(true);
		expect(service.getUrl()).toBe(`http://localhost:${second}`);
		expect(seen.events).toEqual([]);
	});
});

describe("startServer — Angular projects in a folder with a space", () => {
	const PLUGIN = "node_modules/@ngtools/webpack/src/ivy/plugin.js";
	const ORIGINAL =
		"const a = (0, normalizePath)(file);\nconst b = (0, normalizePath)(resource);\n";

	function angular(plugin: string | null, name = "my app"): string {
		return project(
			{
				"package.json": pkg({ dependencies: { "@angular/core": "1" } }),
				"node_modules/": "",
				...(plugin === null ? {} : { [PLUGIN]: plugin }),
			},
			name,
		);
	}

	const run = (dir: string) =>
		drive(
			service.startServer({
				type: "web",
				framework: "angular",
				startCommand: "npx ng serve --port 4200",
				port: 0,
				isWeb: false,
				projectDir: dir,
			}),
		);

	it("decodes the paths @ngtools/webpack looks up, then restores the file on stop", async () => {
		const dir = angular(ORIGINAL);
		world.onSpawn = () => undefined;

		await run(dir);

		expect(readFileSync(path.join(dir, PLUGIN), "utf-8")).toBe(
			"const a = (0, normalizePath)(decodeURIComponent(file));\nconst b = (0, normalizePath)(decodeURIComponent(resource));\n",
		);
		service.stopServer();
		expect(readFileSync(path.join(dir, PLUGIN), "utf-8")).toBe(ORIGINAL);
	});

	it("patches again after a restart, and still restores the original", async () => {
		const dir = angular(ORIGINAL);
		world.onSpawn = () => undefined;
		await run(dir);

		await run(dir);
		expect(readFileSync(path.join(dir, PLUGIN), "utf-8")).toContain(
			"decodeURIComponent(file)",
		);
		service.stopServer();

		expect(readFileSync(path.join(dir, PLUGIN), "utf-8")).toBe(ORIGINAL);
	});

	it.each([
		["const a = (0, normalizePath)(decodeURIComponent(file));"],
		["const a = (0, normalizePath)(decodeURIComponent(resource));"],
		["const a = somethingElse(file);"],
	])("leaves %s as it is", async (content) => {
		const dir = angular(content);
		world.onSpawn = () => undefined;

		await run(dir);
		service.stopServer();

		expect(readFileSync(path.join(dir, PLUGIN), "utf-8")).toBe(content);
	});

	it("has nothing to patch without Angular CLI or without a space", async () => {
		const missing = angular(null);
		const noSpace = angular(ORIGINAL, "myapp");
		world.onSpawn = () => undefined;

		await run(missing);
		await run(noSpace);

		expect(existsSync(path.join(missing, PLUGIN))).toBe(false);
		expect(readFileSync(path.join(noSpace, PLUGIN), "utf-8")).toBe(ORIGINAL);
	});

	it("warns and carries on when the plugin cannot be read", async () => {
		const dir = angular(null);
		addFiles(dir, { [`${PLUGIN}/`]: "" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		world.onSpawn = () => undefined;

		await run(dir);

		expect(warn).toHaveBeenCalledWith(
			"[AppEmulator] Could not patch @ngtools/webpack:",
			expect.anything(),
		);
		expect(world.spawns).toHaveLength(1);
		warn.mockRestore();
	});

	it("does not fail the stop when a patched file has gone", async () => {
		const dir = angular(ORIGINAL);
		world.onSpawn = () => undefined;
		await run(dir);
		addFiles(dir, {});
		const { rmSync } = await import("node:fs");
		rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });

		expect(() => service.stopServer()).not.toThrow();
	});
});

describe("startServer — Windows", () => {
	beforeEach(() => {
		world.windows = true;
	});

	it("runs every command through the shell and installs through it", async () => {
		const dir = project({ "package.json": pkg({ scripts: { dev: "x" } }), "yarn.lock": "" });
		world.onSpawn = (call) => {
			if (call.args[0] === "install") setImmediate(() => call.proc.exit(0));
		};

		await drive(service.startServer({ ...webConfig(dir, 0), isWeb: false, startCommand: "yarn run dev" }));

		expect(world.spawns.map((call) => [call.cmd, call.args, call.options.shell])).toEqual([
			["yarn", ["install"], true],
			["yarn run dev", [], true],
		]);
	});

	it("stops the process tree with taskkill, then frees the port", async () => {
		const port = await freePort();
		world.onSpawn = (call) => {
			if (call.cmd === "npm run dev") void httpServer(Number(call.options.env?.PORT));
			if (call.cmd === "powershell") setImmediate(() => call.proc.exit(0));
		};
		await drive(service.startServer(webConfig(nodeProject(), port)));
		const pid = world.spawns[0].proc.pid;

		service.stopServer();

		expect(spawnsOf("taskkill").map((call) => call.args)).toEqual([
			[["/pid", String(pid), "/f", "/t"]][0],
		]);
		const [ps] = spawnsOf("powershell");
		expect(ps.args.at(-1)).toContain(`Get-NetTCPConnection -LocalPort ${port}`);
	});

	it("kills the process holding the port before moving to another one", async () => {
		const port = await freePort();
		await silentListener(port);
		world.onSpawn = (call) => {
			if (call.cmd === "powershell") setImmediate(() => call.proc.fail("no powershell"));
			else setImmediate(() => call.proc.exit(0));
		};

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(spawnsOf("powershell")[0].args.at(-1)).toContain(`-LocalPort ${port}`);
		expect((seen.of("config")[0] as AppEmulatorConfig).port).toBeGreaterThan(port);
	});

	it("gives up waiting on a port killer that hangs", async () => {
		const port = await freePort();
		await silentListener(port);
		world.onSpawn = (call) => {
			if (call.cmd !== "powershell") setImmediate(() => call.proc.exit(0));
		};

		await drive(service.startServer(webConfig(nodeProject(), port)));

		expect(spawnsOf("powershell")[0].proc.killed).toBe(true);
	});
});

describe("startServer — fullstack", () => {
	function fullstack(backendPort: number, frontendPort: number, frontend = "vite") {
		const root = project({}, "shop");
		addFiles(root, {
			"api/package.json": pkg({ scripts: { dev: "x" } }),
			"api/node_modules/": "",
			"web/package.json": pkg({ scripts: { dev: "x" } }),
			"web/node_modules/": "",
		});
		return {
			type: "web",
			framework: "express",
			startCommand: "npm run dev",
			port: backendPort,
			isWeb: true,
			projectDir: path.join(root, "api"),
			services: [
				{
					label: "Backend (express)",
					framework: "express",
					startCommand: `node server.js --port ${backendPort}`,
					port: backendPort,
					projectDir: path.join(root, "api"),
					isPrimary: true,
				},
				{
					label: `Frontend (${frontend})`,
					framework: frontend,
					startCommand: "npm run dev",
					port: frontendPort,
					projectDir: path.join(root, "web"),
					isPrimary: false,
				},
			],
		} satisfies AppEmulatorConfig;
	}

	it("starts the front, then the API, and opens the front", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = (call) => {
			startsHttpServer()(call);
			setImmediate(() => {
				call.proc.print("listening\n");
				call.proc.print("deprecation\n", "stderr");
			});
		};

		await drive(service.startServer(fullstack(api, web)));

		expect(world.spawns.map((call) => [call.cmd, call.options.env?.PORT])).toEqual([
			["npm", String(web)],
			["node", String(api)],
		]);
		expect(seen.of("output")).toEqual([
			"[Frontend (vite)] Starting: npm run dev",
			"[Frontend (vite)] listening",
			"[Frontend (vite)] deprecation",
			"[Backend (express)] listening",
			"[Backend (express)] deprecation",
		]);
		expect(seen.of("status")).toContain(`Starting: node server.js --port ${api}`);
		expect(seen.of("ready")).toEqual([`http://localhost:${web}`]);
		expect(service.isRunning()).toBe(true);
	});

	it("starts a service without a port as it is", async () => {
		const api = await freePort();
		const config = fullstack(api, 0, "worker");
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(config));

		expect(world.spawns.map((call) => call.options.env?.PORT)).toEqual(["0", String(api)]);
		expect(seen.of("ready")).toEqual([`http://localhost:${api}`]);
	});

	it("gives up quietly on an API that dies as the wait times out", async () => {
		const api = await freePort();
		world.onSpawn = (call) => {
			if (call.cmd === "node") setTimeout(() => call.proc.exit(null), 120_300);
		};

		await drive(service.startServer(fullstack(api, 0, "worker")));

		expect(seen.of("ready")).toEqual([]);
	});

	it("keeps the last 200 lines of the API to explain its exit", async () => {
		const api = await freePort();
		world.onSpawn = (call) => {
			if (call.cmd !== "node") return;
			setImmediate(() => {
				for (let index = 0; index < 205; index++) call.proc.print(`api ${index}\n`);
				call.proc.exit(3);
			});
		};

		await drive(service.startServer(fullstack(api, 0, "worker")));

		const [message] = seen.of("error") as string[];
		expect(message).toContain("api 204");
		expect(message).not.toContain("api 4\n");
	});

	it("goes on checking an API that is slow to listen", async () => {
		const api = await freePort();
		world.onSpawn = (call) => {
			if (call.cmd === "node") setTimeout(() => void httpServer(api), 125_000);
		};

		await drive(service.startServer(fullstack(api, 0, "worker")));

		expect(seen.of("ready")).toEqual([`http://localhost:${api}`]);
	});

	it("does not report an API ready when it dies before answering", async () => {
		const api = await freePort();
		world.onSpawn = (call) => {
			if (call.cmd !== "node") return;
			const server = httpServer(api, 503);
			setTimeout(() => call.proc.exit(0), 3000);
			void server;
		};

		await drive(service.startServer(fullstack(api, 0, "worker")));

		expect(seen.of("ready")).toEqual([]);
	});

	it("opens the API when the other service is not a web front", async () => {
		const [api, worker] = [await freePort(), await freePort()];
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(fullstack(api, worker, "worker")));

		expect(seen.of("ready")).toEqual([`http://localhost:${api}`]);
	});

	it("stops every service it started, each once", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = startsHttpServer();
		await drive(service.startServer(fullstack(api, web)));

		service.stopServer();

		expect(world.spawns.map((call) => call.proc.killSignals)).toEqual([["SIGKILL"], ["SIGKILL"]]);
		world.windows = true;
		await drive(service.startServer(fullstack(await freePort(), await freePort())));
		service.stopServer();
		expect(spawnsOf("taskkill")).toHaveLength(2);
		expect(service.isRunning()).toBe(false);
	});

	it("reuses a service already running, and moves one whose port is held", async () => {
		const [api, web] = [await freePort(), await freePort()];
		await httpServer(web);
		await silentListener(api);
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(fullstack(api, web)));

		const outputs = seen.of("output");
		expect(outputs).toContain(
			`[Frontend (vite)] Port ${web} already has a running server — reusing it`,
		);
		expect(outputs).toContain(`[Backend (express)] Port ${api} occupied — stopping previous process...`);
		expect(world.spawns).toHaveLength(1);
		const moved = (seen.of("config")[0] as AppEmulatorConfig).services?.[0];
		expect(moved?.port).toBeGreaterThan(api);
		expect(moved?.startCommand).toBe(`node server.js --port ${moved?.port}`);
		expect(seen.of("ready")).toEqual([`http://localhost:${web}`]);
	});

	it.each([
		["npm run dev", "vite", "npm run dev -- --port {new}"],
		["ng serve", "angular", "npx ng serve --port {new}"],
	])("rewrites a front command %s for its new port", async (command, framework, expected) => {
		const [api, web] = [await freePort(), await freePort()];
		await silentListener(web);
		const config = fullstack(api, web, framework);
		config.services[1].startCommand = command;
		world.onSpawn = (call) => setImmediate(() => call.proc.exit(0));

		await drive(service.startServer(config));

		const moved = (seen.of("config")[0] as AppEmulatorConfig).services?.[1];
		expect(moved?.startCommand).toBe(expected.replace("{new}", String(moved?.port)));
	});

	it("starts the front even when its install failed", async () => {
		const [api, web] = [await freePort(), await freePort()];
		const config = fullstack(api, web);
		const { rmSync } = await import("node:fs");
		rmSync(path.join(config.services[1].projectDir, "node_modules"), { recursive: true });
		world.onSpawn = (call) => {
			if (call.args[0] === "install") setImmediate(() => call.proc.exit(9));
			else startsHttpServer()(call);
		};

		await drive(service.startServer(config));

		expect(seen.of("output")).toContain(
			'[Frontend (vite)] Error: [Frontend (vite)] "npm install" exited with code 9',
		);
		expect(seen.of("ready")).toEqual([`http://localhost:${web}`]);
	});

	it("does not start the API when its install failed", async () => {
		const [api, web] = [await freePort(), await freePort()];
		const config = fullstack(api, web);
		const { rmSync } = await import("node:fs");
		rmSync(path.join(config.services[0].projectDir, "node_modules"), { recursive: true });
		world.onSpawn = (call) => {
			if (call.args[0] === "install") setImmediate(() => call.proc.exit(9));
		};

		await drive(service.startServer(config));

		expect(seen.of("error")).toEqual([
			'Error: [Backend (express)] "npm install" exited with code 9',
		]);
		expect(world.spawns.map((call) => call.args[0])).toEqual(["run", "install"]);
	});

	it("reports a front that exits or cannot start, and an API that exits", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = (call) =>
			setImmediate(() => {
				if (call.cmd === "npm") call.proc.exit(2);
				else {
					call.proc.print("fatal: port\n");
					call.proc.exit(1);
				}
			});

		await drive(service.startServer(fullstack(api, web)));

		expect(seen.of("output")).toContain("[Frontend (vite)] exited with code 2");
		expect(seen.of("error")).toEqual(["Server exited with code 1\n\nfatal: port"]);
		expect(seen.of("stopped").length).toBeGreaterThan(0);

		world.onSpawn = (call) => setImmediate(() => call.proc.fail("spawn ENOENT"));
		seen.events.length = 0;
		await drive(service.startServer(fullstack(api, web)));

		expect(seen.of("output")).toContain("[Frontend (vite)] failed to start: spawn ENOENT");
		expect(seen.of("error")).toEqual(["Failed to start server: spawn ENOENT"]);
	});

	it("waits for the API port before checking the front", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = (call) => {
			if (call.cmd === "npm") void httpServer(web);
			else setTimeout(() => void httpServer(api), 2000);
		};

		await drive(service.startServer(fullstack(api, web)));

		expect(seen.of("ready")).toEqual([`http://localhost:${web}`]);
	});

	it("does not report ready when the API died before listening", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = (call) => {
			if (call.cmd === "npm") void httpServer(web);
			else setImmediate(() => call.proc.exit(0));
		};

		await drive(service.startServer(fullstack(api, web)));

		expect(seen.of("ready")).toEqual([]);
	});

	it("patches an Angular folder with a space once, for the services it holds", async () => {
		const [api, web] = [await freePort(), await freePort()];
		const config = fullstack(api, web, "angular");
		config.services[0].framework = "angular";
		const plugin = "node_modules/@ngtools/webpack/src/ivy/plugin.js";
		const dir = project({ "package.json": pkg({}), [plugin]: "(0, normalizePath)(file)" }, "my shop");
		for (const svc of config.services) svc.projectDir = dir;
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(config));
		expect(readFileSync(path.join(dir, plugin), "utf-8")).toBe(
			"(0, normalizePath)(decodeURIComponent(file))",
		);
		service.stopServer();

		expect(readFileSync(path.join(dir, plugin), "utf-8")).toBe("(0, normalizePath)(file)");
	});

	it("ignores the late exit of a front it replaced", async () => {
		const [api, web] = [await freePort(), await freePort()];
		world.onSpawn = startsHttpServer();
		await drive(service.startServer(fullstack(api, web)));
		const [oldFront] = world.spawns;
		oldFront.proc.exitOnKill = false;

		const [api2, web2] = [await freePort(), await freePort()];
		await drive(service.startServer(fullstack(api2, web2)));
		const newFront = world.spawns[2];
		oldFront.proc.fail("late");
		oldFront.proc.exit(1);
		world.spawns[1].proc.fail("late");

		service.stopServer();
		expect(newFront.proc.killSignals).toEqual(["SIGKILL"]);
	});

	it("starts no service once stopped while installing", async () => {
		const [api, web] = [await freePort(), await freePort()];
		for (const index of [0, 1]) {
			const config = fullstack(api, web);
			const { rmSync } = await import("node:fs");
			rmSync(path.join(config.services[index].projectDir, "node_modules"), {
				recursive: true,
			});
			world.spawns = [];
			world.onSpawn = (call) => {
				if (call.args[0] === "install") setTimeout(() => call.proc.exit(0), 5000);
			};
			const starting = service.startServer(config);
			await vi.advanceTimersByTimeAsync(2000);
			service.stopServer();
			await drive(starting);

			expect(world.spawns.map((call) => call.args[0])).toEqual(
				index === 0 ? ["run", "install"] : ["install"],
			);
		}
	});

	it("runs the first service as the API when none is marked primary", async () => {
		const [api, web] = [await freePort(), await freePort()];
		const config = fullstack(api, web);
		config.services[0].isPrimary = false;
		world.onSpawn = startsHttpServer();

		await drive(service.startServer(config));

		expect(world.spawns.map((call) => call.options.env?.PORT)).toEqual([
			String(web),
			String(api),
		]);
	});
});
