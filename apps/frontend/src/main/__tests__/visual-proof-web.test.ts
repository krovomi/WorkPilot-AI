/**
 * The visual proof of a web application: the emulator starts it, a hidden
 * window walks to the feature and captures it, the captures are pushed to the
 * task's branch and shown in a PR comment. The app is a real HTTP server, the
 * pages real DOMs, the branch a real git repository with a remote.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualProofRun, VisualProofRunOptions } from "../../shared/types";
import { VisualProofService } from "../visual-proof-service";
import { browserWindows, cleanWorld, closedPort, resetWorld, tempDir, world, appServer } from "./visual-proof-world";

vi.mock("node:child_process", async () => (await import("./visual-proof-world")).childProcessModule());
vi.mock("node:timers/promises", async () => (await import("./visual-proof-world")).timersModule());
vi.mock("electron", async () => (await import("./visual-proof-world")).electronModule());
vi.mock("../platform", async () => (await import("./visual-proof-world")).platformModule());
vi.mock("../dotnet-msbuild", async () => (await import("./visual-proof-world")).dotnetMsbuildModule());
vi.mock("../app-emulator-service", async () => (await import("./visual-proof-world")).appEmulatorModule());
vi.mock("../oneshot-llm", async () => (await import("./visual-proof-world")).oneShotModule());

const HOME = `<!doctype html><html><body>
<a id="invoices" href="/invoices">Invoices</a>
<button data-testid="new">New invoice</button>
<input name="customer" placeholder="Customer">
</body></html>`;

const INVOICES = `<!doctype html><html><body>
<h1 id="title">Invoices</h1>
<input id="search" aria-label="Search">
<button id="filter">Filter</button>
</body></html>`;

const PR = "https://github.com/acme/shop/pull/12";

const realGit = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A task worktree on branch `task/1`, pushed to a bare remote. */
function worktree(): { dir: string; remote: string } {
	const remote = tempDir("vp-remote-");
	realGit(remote, "init", "--bare", "--initial-branch", "main");
	const dir = tempDir("vp-wt-");
	realGit(dir, "init", "--initial-branch", "main");
	realGit(dir, "config", "user.email", "proof@example.com");
	realGit(dir, "config", "user.name", "Proof");
	writeFileSync(path.join(dir, ".gitignore"), ".workpilot/\n");
	writeFileSync(path.join(dir, "index.js"), "console.log('app')\n");
	realGit(dir, "add", ".");
	realGit(dir, "commit", "-m", "init");
	realGit(dir, "remote", "add", "origin", remote);
	realGit(dir, "push", "-q", "origin", "main");
	realGit(dir, "checkout", "-q", "-b", "task/1");
	writeFileSync(path.join(dir, "invoices.js"), "export const invoices = []\n");
	realGit(dir, "add", ".");
	realGit(dir, "commit", "-m", "invoices");
	return { dir, remote };
}

function webApp(url: string, framework = "vite"): void {
	world.emulator.url = url;
	world.emulator.config = {
		type: "web",
		framework,
		startCommand: "npm run dev",
		port: Number(new URL(url).port),
		isWeb: true,
		projectDir: "/somewhere",
	};
}

function options(extra: Partial<VisualProofRunOptions> = {}): VisualProofRunOptions {
	return { taskId: "task-1", projectPath: tempDir("vp-project-"), specId: "001-invoices", ...extra };
}

/** `gh api …/comments` answers the comment URL; the posted bodies are kept. */
function gh(answer: string | Error = "https://github.com/acme/shop/pull/12#issuecomment-1"): string[] {
	const bodies: string[] = [];
	world.programs.set("gh", (args) => {
		bodies.push(args[args.indexOf("-f") + 1]);
		return answer;
	});
	return bodies;
}

beforeEach(() => {
	resetWorld();
	browserWindows.length = 0;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_PROVIDER", "");
	vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", "");
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await cleanWorld();
});

describe("a web application without a PR", () => {
	it("captures the home page of the started app and stops it", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({
			status: "passed",
			provider: "local-web",
			targetKind: "web",
			isolated: false,
			framework: "vite",
			appUrl: url,
			providerDetails: "Local web preview through the app emulator.",
		});
		expect(run.screenshots).toHaveLength(1);
		const [home] = run.screenshots;
		expect(home.label).toBe("Home page");
		expect(home.relativePath).toBe(
			path.join(".workpilot", "specs", "visual-proofs", "001-invoices", run.id, "home.png"),
		);
		expect(readFileSync(home.absolutePath, "utf-8")).toBe(`PNG ${url}`);
		expect(world.emulator.starts).toHaveLength(1);
		expect(world.emulator.stops).toBe(1);
		// No branch, no PR: nothing is committed or posted.
		const writes = world.execs.filter(
			(call) => call.cmd === "gh" || ["add", "commit", "push"].includes(call.args[0]),
		);
		expect(writes).toEqual([]);
		expect(run.commentUrl).toBeUndefined();
		// The capture window is the locked-down one.
		expect(browserWindows.every((window) => window.isDestroyed())).toBe(true);
		expect(browserWindows[0].options).toMatchObject({
			show: false,
			webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
		});
	});

	it("walks to the feature with a generated plan grounded on the real page", async () => {
		const url = await appServer({ "/": HOME, "/invoices": INVOICES });
		webApp(url);
		world.llm = () =>
			`Here is the plan:\n${JSON.stringify({
				web: [
					{ path: "/invoices", waitForSelector: "#title", label: "Invoices list" },
					{ fill: { selector: "#search", value: "ACME" }, capture: false },
					{ click: "#filter", label: "Filtered: ACME!" },
					{ waitForSelector: "#never", click: "#missing", fill: { selector: "#gone", value: "x" } },
				],
			})}`;
		const opts = options();
		mkdirSync(path.join(opts.projectPath, ".workpilot", "specs", "001-invoices"), { recursive: true });
		writeFileSync(
			path.join(opts.projectPath, ".workpilot", "specs", "001-invoices", "spec.md"),
			"# Invoices\nList and filter invoices.",
		);

		const run = await new VisualProofService().run(opts);

		expect(run.error).toBeUndefined();
		expect(run.status).toBe("passed");
		expect(run.screenshots.map((shot) => [shot.label, path.basename(shot.relativePath)])).toEqual([
			["Invoices list", "feature-1-invoices-list.png"],
			["Filtered: ACME!", "feature-2-filtered-acme.png"],
			["Feature step 3", "feature-3.png"],
		]);
		expect(readFileSync(run.screenshots[0].absolutePath, "utf-8")).toBe(`PNG ${url}invoices`);
		// The prompt carries the spec and the real interactive elements of the home page.
		const [prompt] = world.prompts;
		expect(prompt).toContain("List and filter invoices.");
		expect(prompt).toContain('"selector":"#invoices"');
		expect(prompt).toContain('"selector":"[data-testid=\\"new\\"]"');
		expect(prompt).toContain('"selector":"input[name=\\"customer\\"]"');
		// The search field really received the value, in the page itself.
		const search = browserWindows.at(-1)?.dom?.window.document.getElementById("search");
		expect((search as HTMLInputElement | null)?.value).toBe("ACME");
		// The generated plan is kept beside the captures.
		const saved = JSON.parse(readFileSync(path.join(run.artifactDir ?? "", "navigation.generated.json"), "utf-8"));
		expect(saved.web).toHaveLength(4);
	});

	it("falls back to the home page when no step of the plan captures", async () => {
		const url = await appServer({ "/": HOME, "/invoices": INVOICES });
		webApp(url);
		world.llm = () => JSON.stringify({ web: [{ path: "/invoices", capture: false }] });

		const run = await new VisualProofService().run(options());

		expect(run.screenshots.map((shot) => shot.label)).toEqual(["Home page"]);
		expect(readFileSync(run.screenshots[0].absolutePath, "utf-8")).toBe(`PNG ${url}`);
	});

	it("follows a plan written in the project and never asks the model", async () => {
		const url = await appServer({ "/": HOME, "/invoices": INVOICES });
		webApp(url);
		world.llm = () => {
			throw new Error("the model must not be asked");
		};
		const opts = options();
		mkdirSync(path.join(opts.projectPath, ".workpilot"), { recursive: true });
		writeFileSync(
			path.join(opts.projectPath, ".workpilot", "visual-proof-navigation.json"),
			JSON.stringify([{ path: "/invoices", label: "Invoices" }]),
		);

		const run = await new VisualProofService().run(opts);

		expect(run.screenshots.map((shot) => shot.label)).toEqual(["Invoices"]);
		expect(world.prompts).toEqual([]);
	});

	it("still proves the home page when the page cannot be read for the plan", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		world.failLoads.add(url);
		world.llm = () => null;

		const run = await new VisualProofService().run(options());

		// Collecting the DOM failed, then capturing the home page failed too.
		expect(run.status).toBe("failed");
		expect(run.provider).toBe("local-web");
		expect(run.error).toContain("ERR_CONNECTION_REFUSED");
		expect(run.providerDetails).toBe('Provider "local-web" failed before a screenshot could be captured.');
		expect(world.emulator.stops).toBe(1);
	});

	it("fails the run when the emulator exposes no preview URL", async () => {
		webApp("http://127.0.0.1:1/");
		world.emulator.url = null;

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({ status: "failed", error: "App emulator did not expose a preview URL" });
		expect(world.emulator.stops).toBe(1);
	});

	it("runs a docker app through the isolated docker provider", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url, "docker-compose");

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({
			status: "passed",
			provider: "docker",
			isolated: true,
			providerDetails: "Docker-backed web preview through the app emulator.",
		});
	});
});

describe("the API of a web application", () => {
	it("smoke-tests the OpenAPI endpoints and captures the Swagger UI", async () => {
		const openapi = JSON.stringify({
			openapi: "3.0.0",
			paths: {
				"/api/health": { get: {} },
				"/api/broken": { get: {} },
				"/api/items/{id}": { get: {} },
			},
		});
		const url = await appServer({
			"/": HOME,
			"/openapi.json": { type: "application/json", body: openapi },
			"/docs": "<!doctype html><html><body><div id='swagger-ui'></div></body></html>",
			"/api/health": { type: "application/json", body: "{}" },
			"/api/broken": { status: 500, body: "boom" },
		});
		webApp(url, "fastapi");

		const run = await new VisualProofService().run(options());

		expect(run.apiSmoke).toMatchObject({ attempted: 2, passed: 1, swaggerUiUrl: `${url}docs` });
		expect(run.providerDetails).toBe(
			"Local web preview through the app emulator. API smoke: 1/2 endpoints passed.",
		);
		expect(run.screenshots.map((shot) => shot.label)).toEqual(["Home page", "Swagger UI"]);
		expect(existsSync(path.join(run.artifactDir ?? "", "api-smoke-report.md"))).toBe(true);
	});

	it("keeps the proof when the Swagger UI cannot be captured", async () => {
		const url = await appServer({
			"/": HOME,
			"/openapi.json": { type: "application/json", body: JSON.stringify({ openapi: "3.0.0", paths: {} }) },
			"/docs": "<!doctype html><html><body></body></html>",
		});
		webApp(url, "fastapi");
		world.failLoads.add(`${url}docs`);

		const run = await new VisualProofService().run(options());

		expect(run.status).toBe("passed");
		expect(run.screenshots.map((shot) => shot.label)).toEqual(["Home page"]);
		// Nothing was smoked: the details say nothing about the API.
		expect(run.providerDetails).toBe("Local web preview through the app emulator.");
	});
});

describe("publishing on the task's branch", () => {
	it("pushes the captures to the branch and links them in the PR comment", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const { dir, remote } = worktree();
		const bodies = gh();

		const run = await new VisualProofService().run(options({ worktreePath: dir, prUrl: PR }));

		expect(run.status).toBe("passed");
		expect(run.commentUrl).toBe("https://github.com/acme/shop/pull/12#issuecomment-1");
		expect(run.commitSha).toBe(realGit(dir, "rev-parse", "HEAD"));
		expect(realGit(remote, "rev-parse", "task/1")).toBe(run.commitSha);
		const relative = run.screenshots[0].relativePath.replaceAll("\\", "/");
		expect(realGit(remote, "show", "--stat", "--format=%s", "task/1")).toContain(
			"Add visual proof screenshots for 001-invoices",
		);
		expect(run.screenshots[0].url).toBe(`https://github.com/acme/shop/blob/task/1/${relative}?raw=1`);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("Status: **passed**");
		expect(bodies[0]).toContain(`![Home page](https://github.com/acme/shop/blob/task/1/${relative}?raw=1)`);
		const comment = world.execs.find((call) => call.cmd === "gh");
		expect(comment?.args.slice(0, 2)).toEqual(["api", "repos/acme/shop/issues/12/comments"]);
	});

	it("keeps the captures when the branch cannot be pushed", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const { dir } = worktree();
		realGit(dir, "remote", "remove", "origin");

		const run = await new VisualProofService().run(options({ worktreePath: dir }));

		expect(run.status).toBe("passed");
		expect(run.publishError).toContain("origin");
		expect(run.commitSha).toBeUndefined();
		expect(run.screenshots).toHaveLength(1);
		expect(existsSync(run.screenshots[0].absolutePath)).toBe(true);
	});

	it("returns the run when the PR comment cannot be posted, gh not even installed", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const { dir } = worktree();

		const run = await new VisualProofService().run(options({ worktreePath: dir, prUrl: PR }));

		expect(run.status).toBe("passed");
		expect(run.commentUrl).toBeUndefined();
		expect(run.commitSha).toBeDefined();
	});

	it("attaches the scenario walkthrough only when it was asked for", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const { dir } = worktree();
		const verify = path.join(dir, ".workpilot", "specs", "001-invoices", "verify");
		mkdirSync(verify, { recursive: true });
		writeFileSync(path.join(verify, "scenario-walkthrough.gif"), "GIF89a-frames");
		const bodies = gh();

		const without = await new VisualProofService().run(options({ worktreePath: dir, prUrl: PR }));
		const withGif = await new VisualProofService().run(
			options({ worktreePath: dir, prUrl: PR, includeWalkthrough: true }),
		);

		expect(without.walkthrough).toBeUndefined();
		expect(withGif.walkthrough?.label).toBe("Scenario walkthrough");
		expect(withGif.walkthrough?.url).toMatch(/blob\/task\/1\/.*walkthrough\.gif\?raw=1$/);
		expect(bodies[1]).toContain("### Walkthrough");
	});
});

describe("a run that cannot render the task", () => {
	it("reports a project that could not be detected, also in the PR", async () => {
		world.emulator.detectError = new Error("Project directory not found: /gone");
		const bodies = gh();

		const run = await new VisualProofService().run(options({ prUrl: PR }));

		expect(run).toMatchObject({ status: "failed", error: "Project directory not found: /gone" });
		expect(run.commentUrl).toBeDefined();
		expect(bodies[0]).toContain("Error: Project directory not found: /gone");
		expect(bodies[0]).toContain("No screenshot was captured.");
	});

	it("returns the failure when its PR comment cannot be posted either", async () => {
		world.emulator.detectError = new Error("boom");
		gh(new Error("offline"));

		const run = await new VisualProofService().run(options({ prUrl: PR }));

		expect(run).toMatchObject({ status: "failed", error: "boom" });
		expect(run.commentUrl).toBeUndefined();
	});

	it("skips a command-line project no provider can show", async () => {
		world.emulator.config = {
			type: "cli",
			framework: "rust",
			startCommand: "cargo run",
			port: 0,
			isWeb: false,
		};

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({
			status: "skipped",
			targetKind: "remote",
			providerDetails: "No provider can render this task automatically.",
		});
		expect(run.error).toContain("Available provider families");
	});

	it("reports a requested provider that is not configured", async () => {
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_PROVIDER", "hyper-v");

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({
			status: "skipped",
			provider: "hyper-v",
			targetKind: "remote",
			error: "hyper-v visual proof provider is not configured.",
			providerDetails: "WORKPILOT_VISUAL_PROOF_HYPERV_COMMAND is not configured.",
		});
	});

	it("ignores an unknown provider name and picks the provider itself", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);

		const run = await new VisualProofService().run(options({ provider: "teleport" as "docker" }));

		expect(run.provider).toBe("local-web");
	});

	it("reports a desktop target no machine provider is there for", async () => {
		world.emulator.config = { type: "desktop", framework: "electron", startCommand: "x", port: 0, isWeb: false };
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_PROVIDER", "wsl");

		const run = await new VisualProofService().run(options({ provider: "auto" }));

		expect(run).toMatchObject({ status: "skipped", provider: "wsl", targetKind: "remote" });
	});
});

describe("isolated providers", () => {
	it("sends the run to a remote runner and keeps its answer", async () => {
		let received: Record<string, unknown> = {};
		const http = await import("node:http");
		const server = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				received = JSON.parse(body);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ status: "passed", appUrl: "https://vm/app", screenshots: [] }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		world.servers.add(server);
		const { port } = server.address() as { port: number };
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_REMOTE_URL", `http://127.0.0.1:${port}/proof`);
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({
			status: "passed",
			provider: "remote-runner",
			targetKind: "remote",
			isolated: true,
			appUrl: "https://vm/app",
			providerDetails: `http://127.0.0.1:${port}/proof`,
		});
		expect(received).toMatchObject({ options: { taskId: "task-1", specId: "001-invoices" } });
	});

	it("fails the run on a runner error and on an unreachable runner", async () => {
		const url = await appServer({ "/proof": { status: 503, body: "busy" } });
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_REMOTE_URL", `${url}proof`);
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };

		const busy = await new VisualProofService().run(options());
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_REMOTE_URL", `http://127.0.0.1:${await closedPort()}/proof`);
		const down = await new VisualProofService().run(options());

		expect(busy).toMatchObject({
			status: "failed",
			error: "Remote visual proof runner returned HTTP 503",
			isolated: false,
		});
		expect(down.status).toBe("failed");
	});

	it("reports a remote runner requested without its address", async () => {
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };

		const run = await new VisualProofService().run(options({ provider: "remote-runner" }));

		expect(run).toMatchObject({
			status: "skipped",
			error: "Remote visual proof runner is not configured.",
			providerDetails: "WORKPILOT_VISUAL_PROOF_REMOTE_URL is not configured.",
		});
	});

	it("runs the configured WSL command with the run on its environment", async () => {
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_WSL_COMMAND", "/opt/proof/wsl-proof");
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_WSL_ARGS", '["--distro","Ubuntu"]');
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };
		let input = "";
		world.programs.set("/opt/proof/wsl-proof", (args, opts) => {
			input = String(opts.env?.WORKPILOT_VISUAL_PROOF_INPUT);
			expect(args).toEqual(["--distro", "Ubuntu"]);
			return JSON.stringify({ status: "passed", targetKind: "web", providerDetails: "WSL VM" });
		});

		const run = await new VisualProofService().run(options());

		expect(run).toMatchObject({ status: "passed", provider: "wsl", targetKind: "web", isolated: true });
		expect(JSON.parse(input).options.taskId).toBe("task-1");
	});

	it("splits plain arguments, and keeps defaults for an empty answer", async () => {
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_HYPERV_COMMAND", "hv-proof");
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_HYPERV_ARGS", "--vm  win11");
		world.emulator.config = { type: "web", framework: "vite", startCommand: "x", port: 1, isWeb: true };
		const seen: string[][] = [];
		world.programs.set("hv-proof", (args) => {
			seen.push(args);
			return "";
		});

		const run = await new VisualProofService().run(options());
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_HYPERV_ARGS", '{"not":"a list"}');
		await new VisualProofService().run(options());

		expect(run).toMatchObject({ status: "skipped", provider: "hyper-v", providerDetails: "hv-proof" });
		expect(seen).toEqual([["--vm", "win11"], []]);
	});
});

describe("one run per task", () => {
	it("shares a running proof and tells when the task starts and stops running", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		const service = new VisualProofService();
		const changes: Array<[string, boolean]> = [];
		service.on("running-changed", (taskId: string, running: boolean) => changes.push([taskId, running]));
		const opts = options();

		const first = service.run(opts);
		const second = service.run(opts);
		expect(second).toBe(first);
		expect(service.isRunning("task-1")).toBe(true);
		await first;
		await new Promise((resolve) => setImmediate(resolve));

		expect(service.isRunning("task-1")).toBe(false);
		expect(changes).toEqual([
			["task-1", true],
			["task-1", false],
		]);
		expect(world.emulator.starts).toHaveLength(1);
	});
});

describe("publishing a run once its PR exists", () => {
	const shot = path.join(".workpilot", "specs", "visual-proofs", "001-invoices", "r1", "home.png");
	const captured = (extra: Partial<VisualProofRun> = {}): VisualProofRun => ({
		id: "r1",
		status: "passed",
		taskId: "task-1",
		specId: "001-invoices",
		startedAt: "2026-11-15T10:00:00.000Z",
		screenshots: [
			{
				label: "Home page",
				relativePath: shot,
				absolutePath: path.join("/proofs", shot),
				width: 1440,
				height: 1000,
				capturedAt: "2026-11-15T10:00:01.000Z",
			},
		],
		...extra,
	});

	it("links the captures on the branch and comments on the PR, the caller's run untouched", async () => {
		const { dir } = worktree();
		const bodies = gh();
		const run = captured({
			walkthrough: { ...captured().screenshots[0], label: "Scenario walkthrough", relativePath: "walk.gif" },
		});

		const published = await new VisualProofService().publishToPr(run, PR, dir);

		const blob = "https://github.com/acme/shop/blob/task/1/";
		expect(published.prUrl).toBe(PR);
		expect(published.screenshots[0].url).toBe(`${blob}${shot.split(path.sep).join("/")}?raw=1`);
		expect(published.walkthrough?.url).toBe(`${blob}walk.gif?raw=1`);
		expect(published.commentUrl).toBe("https://github.com/acme/shop/pull/12#issuecomment-1");
		expect(bodies[0]).toContain(published.screenshots[0].url);
		expect(run.screenshots[0].url).toBeUndefined();
		expect(run.walkthrough?.url).toBeUndefined();
	});

	it("returns the linked run when the comment cannot be posted", async () => {
		const { dir } = worktree();
		gh(new Error("HTTP 403"));

		const published = await new VisualProofService().publishToPr(captured(), PR, dir);

		expect(published.screenshots[0].url).toMatch(/blob\/task\/1\//);
		expect(published.commentUrl).toBeUndefined();
	});

	it("only stamps a PR that is not on GitHub, or a folder that is not a branch", async () => {
		const { dir } = worktree();
		const bodies = gh();
		const azure = "https://dev.azure.com/acme/shop/_git/shop/pullrequest/7";

		const elsewhere = await new VisualProofService().publishToPr(captured(), azure, dir);
		expect(elsewhere.prUrl).toBe(azure);
		expect(elsewhere.screenshots[0].url).toBeUndefined();
		expect(elsewhere.commentUrl).toBeUndefined();

		const noBranch = await new VisualProofService().publishToPr(captured(), PR, tempDir("vp-not-git-"));
		expect(noBranch.screenshots[0].url).toBeUndefined();
		expect(bodies).toHaveLength(1);
	});
});

describe("a navigation plan that cannot be read", () => {
	it("asks the model when the plan in the settings is not JSON, and proves the home page when it fails", async () => {
		const url = await appServer({ "/": HOME });
		webApp(url);
		vi.stubEnv("WORKPILOT_VISUAL_PROOF_NAVIGATION", "{ web: [");
		world.llm = () => {
			throw new Error("model unavailable");
		};

		const run = await new VisualProofService().run(options());

		expect(world.prompts).toHaveLength(1);
		expect(run.status).toBe("passed");
		expect(run.screenshots.map((screenshot) => screenshot.label)).toEqual(["Home page"]);
	});
});
