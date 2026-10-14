/**
 * ENV_UPDATE rewrites `.workpilot/.env` from a template. A key the template
 * does not print (the Figma token, the docintel / watermarks / verify /
 * libdocs switches, AI_PROVIDER, a line written by hand) must survive the
 * save, value untouched; the keys the template prints keep their behavior.
 * And a value from the renderer stays on its own line, or nothing is written.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult, ProjectEnvConfig } from "../../shared/types";

const { mockGetProject, mockUpdateAutoBuildPath, mockIpcMain } = vi.hoisted(
	() => {
		const handlers = new Map<string, Function>();
		return {
			mockGetProject: vi.fn(),
			mockUpdateAutoBuildPath: vi.fn(),
			mockIpcMain: {
				handlers,
				handle(channel: string, handler: Function): void {
					handlers.set(channel, handler);
				},
			},
		};
	},
);

vi.mock("../claude-cli-utils", () => ({
	getClaudeCliInvocation: vi.fn(),
	getClaudeCliInvocationAsync: vi.fn(),
}));

vi.mock("../project-store", () => ({
	projectStore: {
		getProject: mockGetProject,
		updateAutoBuildPath: mockUpdateAutoBuildPath,
	},
}));

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() =>
			path.join(os.tmpdir(), "workpilot-env-test-userdata"),
		),
	},
	ipcMain: mockIpcMain,
}));

import { registerEnvHandlers } from "../ipc-handlers/env-handlers";

const PROJECT_ID = "project-1";

let projectDir: string;
let envPath: string;

function update(config: Partial<ProjectEnvConfig>): Promise<IPCResult> {
	const handler = mockIpcMain.handlers.get(IPC_CHANNELS.ENV_UPDATE);
	if (!handler) throw new Error("ENV_UPDATE not registered");
	return handler({}, PROJECT_ID, config);
}

function get(): Promise<IPCResult<ProjectEnvConfig>> {
	const handler = mockIpcMain.handlers.get(IPC_CHANNELS.ENV_GET);
	if (!handler) throw new Error("ENV_GET not registered");
	return handler({}, PROJECT_ID);
}

function envLines(): string[] {
	return readFileSync(envPath, "utf-8").split("\n");
}

describe("ENV_UPDATE", () => {
	beforeEach(() => {
		projectDir = mkdtempSync(path.join(os.tmpdir(), "workpilot-env-"));
		mkdirSync(path.join(projectDir, ".workpilot"));
		envPath = path.join(projectDir, ".workpilot", ".env");
		mockGetProject.mockReturnValue({
			id: PROJECT_ID,
			path: projectDir,
			autoBuildPath: ".workpilot",
		});
		mockUpdateAutoBuildPath.mockClear();
		mockIpcMain.handlers.clear();
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	describe("keeps the keys its template does not own", () => {
		it("keeps FIGMA_ACCESS_TOKEN, WATERMARKS_ENABLED and AI_PROVIDER after an unrelated change", async () => {
			writeFileSync(
				envPath,
				[
					"GITHUB_REPO=owner/repo",
					"FIGMA_ACCESS_TOKEN=figd_test-0000",
					"WATERMARKS_ENABLED=false",
					"AI_PROVIDER=ollama",
					"",
				].join("\n"),
			);

			const result = await update({ defaultBranch: "develop" });

			expect(result.success).toBe(true);
			const lines = envLines();
			expect(lines).toContain("FIGMA_ACCESS_TOKEN=figd_test-0000");
			expect(lines).toContain("WATERMARKS_ENABLED=false");
			expect(lines).toContain("AI_PROVIDER=ollama");
			expect(lines).toContain("DEFAULT_BRANCH=develop");
			expect(
				lines.filter((line) => line === "GITHUB_REPO=owner/repo"),
			).toHaveLength(1);
		});

		it("copies a kept line as written, quotes, spaces and '#' included", async () => {
			const kept = [
				'WORKPILOT_TESSERACT_PATH="/opt/tess dir/tesseract"',
				"LIBDOCS_TOPIC='auth # tokens'",
				"VERIFY_TIMEOUT = 120",
				"CONTEXT7_API_URL=https://context7.example/api?x=1&y=2",
			];
			writeFileSync(envPath, `${kept.join("\r\n")}\r\n`);

			await update({ enableFancyUi: false });

			const lines = envLines();
			for (const line of kept) {
				expect(lines).toContain(line);
			}
		});

		it("writes the same file on a second save", async () => {
			writeFileSync(
				envPath,
				"FIGMA_ACCESS_TOKEN=figd_test-0000\nDOCINTEL_ENABLED=false\n",
			);

			await update({ defaultBranch: "develop" });
			const first = readFileSync(envPath, "utf-8");
			await update({ defaultBranch: "develop" });

			expect(readFileSync(envPath, "utf-8")).toBe(first);
			expect(
				envLines().filter((line) => line.startsWith("DOCINTEL_ENABLED=")),
			).toHaveLength(1);
		});

		it("adds no section when every key belongs to the template", async () => {
			writeFileSync(envPath, "GITHUB_REPO=owner/repo\n");

			await update({ defaultBranch: "develop" });

			expect(readFileSync(envPath, "utf-8")).not.toContain("OTHER SETTINGS");
		});

		it("does not bring back a template key the save removed", async () => {
			writeFileSync(
				envPath,
				[
					"AGENT_MCP_coder_ADD=context7",
					'CUSTOM_MCP_SERVERS=[{"id":"x"}]',
					"FIGMA_ACCESS_TOKEN=figd_test-0000",
					"",
				].join("\n"),
			);

			await update({
				agentMcpOverrides: { qa_reviewer: { remove: ["puppeteer"] } },
				customMcpServers: [],
			});

			const content = readFileSync(envPath, "utf-8");
			expect(content).not.toContain("AGENT_MCP_coder_ADD");
			expect(content).toContain("AGENT_MCP_qa_reviewer_REMOVE=puppeteer");
			expect(content).not.toMatch(/^CUSTOM_MCP_SERVERS=/m);
			expect(content).toContain("FIGMA_ACCESS_TOKEN=figd_test-0000");
		});

		it("persists the rtk, ui-ux-pro-max and Chrome DevTools switches it writes", async () => {
			writeFileSync(envPath, "RTK_ENABLED=true\n");

			await update({
				tokenSavings: { rtkEnabled: false, rtkModelFacing: false },
				uiux: { enabled: false, persistMaster: false },
				mcpServers: { chromeDevtoolsEnabled: true },
			});

			const lines = envLines();
			expect(lines.filter((line) => line.startsWith("RTK_ENABLED="))).toEqual(
				["RTK_ENABLED=false"],
			);
			const read = await get();
			expect(read.data?.tokenSavings).toEqual({
				rtkEnabled: false,
				rtkModelFacing: false,
			});
			expect(read.data?.uiux).toEqual({ enabled: false, persistMaster: false });
			expect(read.data?.mcpServers?.chromeDevtoolsEnabled).toBe(true);
		});
	});

	describe("refuses a value holding a line break", () => {
		const BEFORE = "GITHUB_REPO=owner/repo\n";

		beforeEach(() => {
			writeFileSync(envPath, BEFORE);
		});

		it("refuses a top-level value and leaves the file as it was", async () => {
			const result = await update({ githubRepo: "owner/repo\nINJECTED=1" });

			expect(result.success).toBe(false);
			expect(result.error).toContain("config.githubRepo");
			expect(result.error).not.toContain("INJECTED");
			expect(readFileSync(envPath, "utf-8")).toBe(BEFORE);
		});

		// `\r` and `\n` end a line for parseEnvFile; the rest are what Python's
		// str.splitlines() also splits on, and most backend readers use it.
		it.each([
			["000D", "\r"],
			["000B", "\v"],
			["000C", "\f"],
			["001C", "\x1c"],
			["001D", "\x1d"],
			["001E", "\x1e"],
			["0085", "\x85"],
			["2028", "\u2028"],
			["2029", "\u2029"],
		])("refuses U+%s in a nested value", async (_code, lineBreak) => {
			const result = await update({
				mcpServers: { context7ApiKey: `ctx7-test-0000${lineBreak}INJECTED=1` },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("config.mcpServers.context7ApiKey");
			expect(readFileSync(envPath, "utf-8")).toBe(BEFORE);
		});

		it("refuses a custom MCP server field JSON.stringify would write raw", async () => {
			const result = await update({
				customMcpServers: [
					{ id: "srv", name: "Server\u2028INJECTED=1", type: "http" },
				],
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("config.customMcpServers[0].name");
			expect(readFileSync(envPath, "utf-8")).toBe(BEFORE);
		});

		it("refuses a line break in an object key, without echoing the key", async () => {
			const result = await update({
				agentMcpOverrides: { "coder\nINJECTED": { add: ["context7"] } },
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("config.agentMcpOverrides (a key)");
			expect(result.error).not.toContain("INJECTED");
			expect(readFileSync(envPath, "utf-8")).toBe(BEFORE);
		});

		it("refuses before touching an uninitialized project", async () => {
			mockGetProject.mockReturnValue({ id: PROJECT_ID, path: projectDir });
			rmSync(path.join(projectDir, ".workpilot"), { recursive: true });

			const result = await update({ defaultBranch: "main\nINJECTED=1" });

			expect(result.success).toBe(false);
			expect(mockUpdateAutoBuildPath).not.toHaveBeenCalled();
			expect(existsSync(path.join(projectDir, ".workpilot"))).toBe(false);
		});

		it("still saves a config that holds a cycle", async () => {
			const config: Partial<ProjectEnvConfig> & { self?: unknown } = {
				defaultBranch: "develop",
			};
			config.self = config;

			const result = await update(config);

			expect(result.success).toBe(true);
			expect(envLines()).toContain("DEFAULT_BRANCH=develop");
		});
	});
});
