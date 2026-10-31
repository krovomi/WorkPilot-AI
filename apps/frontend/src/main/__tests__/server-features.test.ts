/**
 * Server mode in the app: a server project's shared features, roadmap first.
 *
 * Its files come from the server into the project's mirror, only those the
 * feature declares and each under its size; a change goes back with the
 * version it started from, and a refusal reads the mirror again. A server job
 * is followed like the local runner: output on stdout, then exit.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";

let TEST_DIR: string;

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => path.join(TEST_DIR, "userData")) },
}));

const connection = vi.hoisted(() => ({ authedFetch: vi.fn() }));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
	getServerUrl: () => "https://wp.example",
	isServerMode: () => true,
}));

const PROJECT_ID = "6f1c2b9e-0d4a-4c1e-9a7b-1f2e3d4c5b6a";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function project(): Project {
	return {
		id: PROJECT_ID,
		name: "Shop",
		path: path.join(TEST_DIR, "mirror"),
		autoBuildPath: ".workpilot",
		settings: {} as Project["settings"],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		remote: { repoUrl: "https://git.example/shop.git", defaultBranch: "main", role: "member" },
	};
}

function roadmapFile(p: Project, name = "roadmap.json") {
	return path.join(p.path, ".workpilot", "roadmap", name);
}

beforeEach(() => {
	TEST_DIR = mkdtempSync(path.join(tmpdir(), "server-features-test-"));
	connection.authedFetch.mockReset();
	vi.resetModules();
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("a shared feature's files", () => {
	it("mirrors only the declared files, each under its size", async () => {
		const p = project();
		mkdirSync(path.dirname(roadmapFile(p)), { recursive: true });
		writeFileSync(roadmapFile(p, "roadmap_discovery.json"), "stale", "utf-8");
		connection.authedFetch.mockResolvedValue({
			ok: true,
			data: {
				files: {
					"roadmap.json": { content: '{"features":[]}', sha256: SHA_A },
					"competitor_analysis.json": { content: "x".repeat(1_000_001), sha256: SHA_A },
					"../../escape.json": { content: "{}", sha256: SHA_A },
					"roadmap_discovery.json": { content: "<html>", sha256: SHA_A },
					"notes.txt": { content: "no", sha256: SHA_A },
				},
				job: { id: "job-1", status: "running", error: null },
			},
		});
		const { pullFeature } = await import("../server-features");
		const result = await pullFeature(p, "roadmap");

		expect(connection.authedFetch).toHaveBeenCalledWith(
			`/api/features/roadmap/snapshot?project_id=${PROJECT_ID}`,
			"GET",
		);
		expect(result).toEqual({
			success: true,
			data: { job: { id: "job-1", status: "running", error: null } },
		});
		expect(readFileSync(roadmapFile(p), "utf-8")).toBe('{"features":[]}');
		expect(existsSync(roadmapFile(p, "competitor_analysis.json"))).toBe(false);
		// Gone on the server, or not a JSON object: gone from the mirror.
		expect(existsSync(roadmapFile(p, "roadmap_discovery.json"))).toBe(false);
		expect(existsSync(path.join(TEST_DIR, "escape.json"))).toBe(false);
		expect(existsSync(roadmapFile(p, "notes.txt"))).toBe(false);
	});

	it("sends a change with the version it read, and reads again when refused", async () => {
		const p = project();
		connection.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { files: { "roadmap.json": { content: "{}", sha256: SHA_A } }, job: null },
		});
		const { pullFeature, pushFeatureFile } = await import("../server-features");
		await pullFeature(p, "roadmap");
		writeFileSync(roadmapFile(p), '{"features":[1]}', "utf-8");

		connection.authedFetch.mockResolvedValueOnce({ ok: true, data: { sha256: SHA_B } });
		expect(await pushFeatureFile(p, "roadmap", "roadmap.json")).toEqual({ success: true });
		expect(connection.authedFetch).toHaveBeenLastCalledWith(
			`/api/features/roadmap/files/roadmap.json?project_id=${PROJECT_ID}`,
			"PUT",
			{ content: '{"features":[1]}', base_sha256: SHA_A },
		);

		// A teammate saved in between: refused, and the mirror shows their version.
		writeFileSync(roadmapFile(p), '{"features":[2]}', "utf-8");
		connection.authedFetch
			.mockResolvedValueOnce({ ok: false, error: "Changed on the server since it was read" })
			.mockResolvedValueOnce({
				ok: true,
				data: { files: { "roadmap.json": { content: '{"theirs":1}', sha256: SHA_A } } },
			});
		const refused = await pushFeatureFile(p, "roadmap", "roadmap.json");
		expect(refused).toEqual({
			success: false,
			error: "Changed on the server since it was read",
		});
		expect(connection.authedFetch.mock.calls[2][2]).toEqual({
			content: '{"features":[2]}',
			base_sha256: SHA_B,
		});
		expect(readFileSync(roadmapFile(p), "utf-8")).toBe('{"theirs":1}');

		expect(await pushFeatureFile(p, "roadmap", "../../etc/passwd")).toEqual({
			success: false,
			error: "Unknown file",
		});
	});
});

describe("a server job, followed like a process", () => {
	it("relays its output, reads the files, then exits 0", async () => {
		const p = project();
		connection.authedFetch.mockImplementation(async (url: string, method: string) => {
			if (method === "POST") return { ok: true, data: { id: "job-1", status: "queued" } };
			if (url.includes("/jobs/job-1?after=0")) {
				return { ok: true, data: { id: "job-1", status: "running", lines: ["Analyzing"], next: 1 } };
			}
			if (url.includes("/jobs/job-1?after=1")) {
				return { ok: true, data: { id: "job-1", status: "succeeded", lines: ["Done"], next: 2 } };
			}
			return {
				ok: true,
				data: { files: { "roadmap.json": { content: '{"features":[]}', sha256: SHA_A } } },
			};
		});
		const { relayServerJob } = await import("../server-features");
		const job = relayServerJob(p, "roadmap", { options: { refresh: true } }, { pollMs: 1 });
		const output: string[] = [];
		job.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf-8")));
		const code = await new Promise((resolve) => job.on("exit", resolve));

		expect(code).toBe(0);
		expect(output.join("")).toBe("Analyzing\nDone\n");
		expect(connection.authedFetch).toHaveBeenCalledWith(
			`/api/features/roadmap/jobs?project_id=${PROJECT_ID}`,
			"POST",
			{ refresh: true },
		);
		expect(readFileSync(roadmapFile(p), "utf-8")).toBe('{"features":[]}');
	});

	it("asks the server to stop it, and reports a refusal to start", async () => {
		const p = project();
		connection.authedFetch.mockImplementation(async (url: string, method: string) => {
			if (url.includes("/cancel")) return { ok: true, data: { cancelled: true } };
			if (method === "POST") return { ok: true, data: { id: "job-2", status: "queued" } };
			return { ok: true, data: { id: "job-2", status: "running", lines: [], next: 0 } };
		});
		const { relayServerJob } = await import("../server-features");
		const job = relayServerJob(p, "roadmap", { options: {} }, { pollMs: 1 });
		job.kill();
		await vi.waitFor(() =>
			expect(connection.authedFetch).toHaveBeenCalledWith(
				`/api/features/roadmap/jobs/job-2/cancel?project_id=${PROJECT_ID}`,
				"POST",
			),
		);
		connection.authedFetch.mockImplementation(async () => ({
			ok: true,
			data: { id: "job-2", status: "cancelled", lines: [], next: 0 },
		}));
		expect(await new Promise((resolve) => job.on("exit", resolve))).toBe(null);

		connection.authedFetch.mockReset();
		connection.authedFetch.mockResolvedValue({
			ok: false,
			error: "A job is already running for this feature",
		});
		const refused = relayServerJob(p, "roadmap", { options: {} }, { pollMs: 1 });
		const errors: string[] = [];
		refused.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString("utf-8")));
		expect(await new Promise((resolve) => refused.on("exit", resolve))).toBe(1);
		expect(errors.join("")).toContain("already running");
	});
});
