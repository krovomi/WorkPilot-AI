/**
 * The project's CI, for the cross-feature journeys: a Jenkins on 127.0.0.1
 * that answers the calls the app makes to one, and the step of the
 * project's pipeline that reports a red build to Self-Healing.
 *
 * - CI/CD Triggers starts a build with `POST /job/<job>/buildWithParameters`
 *   (`apps/backend/runners/cicd_triggers_runner.py`): the build is recorded,
 *   with the branch and the pull request it names, and answered 201.
 * - Anything else (the pipeline loop's `lastBuild/api/json`...) is recorded
 *   and answered 404, "no build for this branch yet", so no other feature
 *   is driven from here without the spec saying so.
 *
 * A build "runs" only when the spec says how it ends (`failBuild`): the
 * pipeline's last step then does what a project's CI does with a red build,
 * `runners/self_healing_runner.py cicd`, with the commit the branch points to
 * and the test output. Nothing here talks to the network beyond 127.0.0.1.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { isWindows, withExecutableExtension } from "../../src/main/platform";
import { withoutCredentials } from "../app-harness";

const BACKEND = path.resolve(import.meta.dirname, "..", "..", "..", "backend");

/** A call the fake CI received. */
export interface CiCall {
	method: string;
	path: string;
	params: Record<string, string>;
	/** Whether it carried an `Authorization` header (it should not: no token is set). */
	authorized: boolean;
}

/** A build CI/CD Triggers asked for. */
export interface BuildRequest {
	job: string;
	branch: string;
	prUrl: string;
}

export interface FakeCi {
	/** The Jenkins URL to give the project's CI/CD settings. */
	url: string;
	calls: () => CiCall[];
	builds: () => BuildRequest[];
	/**
	 * Ends `build` red, as the pipeline would: its last step reports the
	 * failure to Self-Healing in `projectDir`. Resolves once it has.
	 */
	failBuild: (projectDir: string, build: BuildRequest, testOutput: string) => Promise<void>;
	stop: () => Promise<void>;
}

const BUILD_PATH = /^\/job\/([^/]+)\/buildWithParameters$/;

function record(request: IncomingMessage): CiCall {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	return {
		method: request.method ?? "GET",
		path: url.pathname,
		params: Object.fromEntries(url.searchParams),
		authorized: request.headers.authorization !== undefined,
	};
}

/** The backend's own Python (`apps/backend/.venv`), on every OS. */
export function backendPython(): string {
	const python = path.join(
		BACKEND,
		".venv",
		isWindows() ? "Scripts" : "bin",
		withExecutableExtension("python"),
	);
	if (!existsSync(python)) {
		throw new Error(`no backend virtualenv at ${python}: install the backend first`);
	}
	return python;
}

export async function startFakeCi(): Promise<FakeCi> {
	const calls: CiCall[] = [];
	const server = createServer((request, response) => {
		const call = record(request);
		calls.push(call);
		// The body is not read: a trigger carries its parameters in the query.
		request.resume();
		const isBuild = call.method === "POST" && BUILD_PATH.test(call.path);
		response.writeHead(isBuild ? 201 : 404, { "Content-Type": "text/plain" });
		response.end(isBuild ? "" : "Not Found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${port}`;

	const builds = (): BuildRequest[] =>
		calls
			.filter((c) => c.method === "POST" && BUILD_PATH.test(c.path))
			.map((c) => ({
				job: decodeURIComponent(BUILD_PATH.exec(c.path)?.[1] ?? ""),
				branch: c.params.BRANCH ?? "",
				prUrl: c.params.PR_URL ?? "",
			}));

	const failBuild = async (
		projectDir: string,
		build: BuildRequest,
		testOutput: string,
	): Promise<void> => {
		const commit = execFileSync("git", ["rev-parse", build.branch], {
			cwd: projectDir,
			encoding: "utf-8",
		}).trim();
		const number = builds().indexOf(build) + 1;
		const args = [
			path.join(BACKEND, "runners", "self_healing_runner.py"),
			"--project",
			projectDir,
			"cicd",
			"--commit",
			commit,
			"--branch",
			build.branch,
			"--test-output",
			testOutput,
			"--ci-log-url",
			`${url}/job/${encodeURIComponent(build.job)}/${number}/console`,
		];
		await new Promise<void>((resolve, reject) => {
			execFile(
				backendPython(),
				args,
				{
					cwd: BACKEND,
					env: { ...withoutCredentials(process.env), PYTHONUTF8: "1" },
					timeout: 60_000,
				},
				// The runner exits 1 when no fix was applied, which is the case
				// whenever the incident waits for a person: only a crash fails here.
				(error, stdout, stderr) =>
					error && error.code !== 1
						? reject(new Error(`self-healing report failed: ${error.message}\n${stdout}\n${stderr}`))
						: resolve(),
			);
		});
	};

	return {
		url,
		calls: () => [...calls],
		builds,
		failBuild,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
