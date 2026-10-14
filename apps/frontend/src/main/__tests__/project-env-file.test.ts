/**
 * @vitest-environment node
 *
 * A project's `.workpilot/.env` holds integration tokens the Python backend
 * reads. project-env-file is its only reader and writer: secret values
 * encrypted on write, decrypted on read, legacy plaintext migrated, the file
 * restricted to its owner, and git told to ignore it.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => tmpdir() },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

vi.mock("../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

const fake = sharedFakeSafeStorage();
const isWindows = process.platform === "win32";

type ProjectEnvFile = typeof import("../project-env-file");
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<ProjectEnvFile & SecretStorage> {
	vi.resetModules();
	return {
		...(await import("../project-env-file")),
		...(await import("../secret-storage")),
	};
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const SAMPLE = `# WorkPilot AI Framework Environment Variables
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret
GITHUB_ENABLED=true
GITHUB_REPO=owner/repo
GITHUB_TOKEN="ghp_secret"
JIRA_PROJECT_KEY=PROJ
# LINEAR_API_KEY=
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/secret
`;

describe("project .workpilot/.env secrets", () => {
	let projectDir: string;
	let envPath: string;

	beforeEach(() => {
		fake.reset();
		projectDir = mkdtempSync(path.join(tmpdir(), "project-env-"));
		envPath = path.join(projectDir, ".workpilot", ".env");
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("names the secret keys and leaves configuration readable", async () => {
		const { isSecretProjectEnvKey } = await load();

		for (const key of [
			"CLAUDE_CODE_OAUTH_TOKEN",
			"GITHUB_TOKEN",
			"GITLAB_TOKEN",
			"LINEAR_API_KEY",
			"JIRA_API_TOKEN",
			"AZURE_DEVOPS_PAT",
			"CICD_JENKINS_TOKEN",
			"OPENAI_API_KEY",
			"CONTEXT7_API_KEY",
			"FIGMA_ACCESS_TOKEN",
			"DOCINTEL_AZURE_KEY",
			"SLACK_WEBHOOK_URL",
			"NOTIFY_WEBHOOK_URL",
		]) {
			expect(isSecretProjectEnvKey(key), key).toBe(true);
		}
		for (const key of [
			"GITHUB_REPO",
			"GITHUB_ENABLED",
			"JIRA_PROJECT_KEY",
			"JIRA_EMAIL",
			"CICD_JENKINS_USER",
			"SLACK_NOTIFICATIONS_ENABLED",
			"CUSTOM_MCP_SERVERS",
			"AGENT_MCP_coder_ADD",
			"OLLAMA_BASE_URL",
		]) {
			expect(isSecretProjectEnvKey(key), key).toBe(false);
		}
	});

	it("writes secret values encrypted and every other line as is", async () => {
		const { writeProjectEnvFile } = await load();

		writeProjectEnvFile(envPath, SAMPLE);

		const raw = readFileSync(envPath, "utf-8");
		expect(raw).not.toContain("secret");
		expect(raw).toBe(`# WorkPilot AI Framework Environment Variables
CLAUDE_CODE_OAUTH_TOKEN=${fakeEncrypted("sk-ant-oat01-secret")}
GITHUB_ENABLED=true
GITHUB_REPO=owner/repo
GITHUB_TOKEN=${fakeEncrypted("ghp_secret")}
JIRA_PROJECT_KEY=PROJ
# LINEAR_API_KEY=
SLACK_WEBHOOK_URL=${fakeEncrypted("https://hooks.slack.com/services/secret")}
`);
	});

	it("reads the secrets back decrypted", async () => {
		const { writeProjectEnvFile, readProjectEnv, readProjectEnvFor } =
			await load();
		writeProjectEnvFile(envPath, SAMPLE);

		const expected = {
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret",
			GITHUB_ENABLED: "true",
			GITHUB_REPO: "owner/repo",
			GITHUB_TOKEN: "ghp_secret",
			JIRA_PROJECT_KEY: "PROJ",
			SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/secret",
		};
		expect(readProjectEnv(envPath)).toEqual(expected);
		expect(readProjectEnvFor(projectDir, ".workpilot")).toEqual(expected);
		expect(readProjectEnvFor(projectDir, undefined)).toEqual(expected);
	});

	it("reads nothing from a file that does not exist", async () => {
		const { readProjectEnv, readProjectEnvContent } = await load();

		expect(readProjectEnv(envPath)).toEqual({});
		expect(readProjectEnvContent(envPath)).toBeUndefined();
	});

	it("is idempotent: encrypted values are not encrypted twice", async () => {
		const { writeProjectEnvFile, readProjectEnvContent } = await load();
		writeProjectEnvFile(envPath, SAMPLE);
		const first = readFileSync(envPath, "utf-8");

		writeProjectEnvFile(envPath, first);

		expect(readFileSync(envPath, "utf-8")).toBe(first);
		expect(readProjectEnvContent(envPath)).toBe(
			SAMPLE.replace('"ghp_secret"', "ghp_secret"),
		);
	});

	it.skipIf(isWindows)("restricts the file to its owner (0600)", async () => {
		mkdirSync(path.dirname(envPath), { recursive: true });
		writeFileSync(envPath, "GITHUB_REPO=a/b\n", { mode: 0o644 });
		const { writeProjectEnvFile } = await load();

		writeProjectEnvFile(envPath, SAMPLE);

		expect(statSync(envPath).mode & 0o777).toBe(0o600);
	});

	describe("without an OS keyring", () => {
		async function expectClearAndWarned(): Promise<void> {
			const { writeProjectEnvFile, getSecureStorageStatus } = await load();

			writeProjectEnvFile(envPath, SAMPLE);

			expect(readFileSync(envPath, "utf-8")).toBe(SAMPLE);
			expect(getSecureStorageStatus().secretsAtRisk).toBe(true);
			if (!isWindows) {
				expect(statSync(envPath).mode & 0o777).toBe(0o600);
			}
		}

		it("safeStorage unavailable: writes in clear in a 0600 file and warns", async () => {
			fake.state.ready = false;
			await expectClearAndWarned();
		});

		it.skipIf(process.platform !== "linux")(
			"Linux basic_text backend: writes in clear in a 0600 file and warns",
			async () => {
				fake.state.backend = "basic_text";
				await expectClearAndWarned();
			},
		);
	});

	describe("a value that cannot be decrypted right now", () => {
		const locked = `GITHUB_REPO=owner/repo\nGITHUB_TOKEN=${fakeEncrypted("ghp_secret")}\n`;

		beforeEach(() => {
			mkdirSync(path.dirname(envPath), { recursive: true });
			writeFileSync(envPath, locked);
			fake.state.failDecrypt = true;
		});

		it("is never handed out as a token", async () => {
			const { readProjectEnv } = await load();

			expect(readProjectEnv(envPath)).toEqual({ GITHUB_REPO: "owner/repo" });
		});

		it("is kept as stored when the file is written back", async () => {
			const { readProjectEnvContent, writeProjectEnvFile } = await load();

			const content = readProjectEnvContent(envPath);
			expect(content).toBe(locked);
			writeProjectEnvFile(envPath, `${content}GITHUB_ENABLED=true\n`);

			expect(readFileSync(envPath, "utf-8")).toBe(
				`${locked}GITHUB_ENABLED=true\n`,
			);
		});
	});

	describe("startup migration", () => {
		it("encrypts a file written in clear and restricts it", async () => {
			mkdirSync(path.dirname(envPath), { recursive: true });
			writeFileSync(envPath, SAMPLE, { mode: 0o644 });
			const { migrateProjectEnvSecrets, readProjectEnv } = await load();

			expect(
				migrateProjectEnvSecrets([
					{ path: projectDir, autoBuildPath: ".workpilot" },
				]),
			).toBe(1);

			const raw = readFileSync(envPath, "utf-8");
			expect(raw).not.toContain("secret");
			expect(raw).toContain("GITHUB_REPO=owner/repo");
			expect(readProjectEnv(envPath).GITHUB_TOKEN).toBe("ghp_secret");
			if (!isWindows) {
				expect(statSync(envPath).mode & 0o777).toBe(0o600);
			}
		});

		it("leaves an already encrypted file alone", async () => {
			const { migrateProjectEnvSecrets, writeProjectEnvFile } = await load();
			writeProjectEnvFile(envPath, SAMPLE);
			const before = readFileSync(envPath, "utf-8");
			const encryptions = fake.calls.encrypt;

			expect(
				migrateProjectEnvSecrets([
					{ path: projectDir, autoBuildPath: ".workpilot" },
				]),
			).toBe(0);
			expect(readFileSync(envPath, "utf-8")).toBe(before);
			expect(fake.calls.encrypt).toBe(encryptions);
		});

		it("skips projects without a file or not initialised", async () => {
			const { migrateProjectEnvSecrets } = await load();

			expect(
				migrateProjectEnvSecrets([
					{ path: projectDir, autoBuildPath: ".workpilot" },
					{ path: projectDir, autoBuildPath: null },
					{ path: path.join(projectDir, "missing"), autoBuildPath: ".workpilot" },
				]),
			).toBe(0);
		});
	});

	describe.skipIf(!hasGit())("git ignores the file", () => {
		function git(...args: string[]): void {
			execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
		}

		it("adds .workpilot/ to .gitignore when git would track the file", async () => {
			git("init", "-q");
			writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n");
			const { writeProjectEnv } = await load();

			writeProjectEnv(projectDir, ".workpilot", SAMPLE);

			const gitignore = readFileSync(
				path.join(projectDir, ".gitignore"),
				"utf-8",
			);
			expect(gitignore).toContain("node_modules/\n");
			expect(gitignore).toContain(".workpilot/\n");
		});

		it("leaves .gitignore alone when the file is already ignored", async () => {
			git("init", "-q");
			writeFileSync(path.join(projectDir, ".gitignore"), ".workpilot/\n");
			const { writeProjectEnv } = await load();

			writeProjectEnv(projectDir, ".workpilot", SAMPLE);

			expect(readFileSync(path.join(projectDir, ".gitignore"), "utf-8")).toBe(
				".workpilot/\n",
			);
		});

		it("touches nothing outside a git repository", async () => {
			const { writeProjectEnv } = await load();

			writeProjectEnv(projectDir, ".workpilot", SAMPLE);

			expect(() =>
				readFileSync(path.join(projectDir, ".gitignore"), "utf-8"),
			).toThrow();
		});
	});
});
