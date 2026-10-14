/**
 * @vitest-environment node
 *
 * No API key or token reaches main.log, the console, or a debug report.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ logFile: "" }));

const { logMock, frontendLogMock } = vi.hoisted(() => ({
	logMock: {
		hooks: [] as Array<(message: { data: unknown[] }) => unknown>,
		initialize: vi.fn(),
		transports: {
			file: {
				maxSize: 0,
				fileName: "main.log",
				level: "info",
				getFile: () => ({ path: state.logFile }),
			},
			console: { level: false },
		},
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	frontendLogMock: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("electron-log/main.js", () => ({ default: logMock }));
vi.mock("electron", () => ({
	app: {
		getVersion: () => "1.0.0",
		getLocale: () => "en-US",
		getPath: () => tmpdir(),
		isPackaged: false,
	},
}));
vi.mock("../colored-logs", () => ({ frontendLog: frontendLogMock }));
vi.mock("../settings-utils", () => ({ readSettingsFile: () => undefined }));

const SECRET = "sk-ant-api03-supersecretvalue";

describe("app-logger redaction", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "app-logger-redaction-"));
		state.logFile = path.join(dir, "main.log");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("registers a hook that redacts every message before a transport writes it", async () => {
		const { redactLogMessage } = await import("../app-logger");
		expect(logMock.hooks).toContain(redactLogMessage);

		const message = {
			data: [
				`token refresh with ${SECRET}`,
				{ apiKey: "opaque-value", provider: "anthropic" },
				new Error(`401 for ${SECRET}`),
			],
			date: new Date(),
			level: "warn" as const,
			variables: { processType: "main" },
		};
		const result = redactLogMessage(message) as typeof message;

		const written = JSON.stringify(result.data) + String(result.data[2]);
		expect(written).not.toContain("supersecretvalue");
		expect(written).not.toContain("opaque-value");
		expect(result.data[1]).toEqual({
			apiKey: "[REDACTED]",
			provider: "anthropic",
		});
		// The caller's objects are untouched.
		expect(message.data[0]).toContain(SECRET);
	});

	it("redacts the console copy of appLog", async () => {
		const { appLog } = await import("../app-logger");

		appLog.warn(`using ${SECRET}`, { authorization: "Bearer abcdefghijkl" });

		expect(frontendLogMock.warn).toHaveBeenCalledWith(
			"using sk-ant-[REDACTED]",
			{ authorization: "[REDACTED]" },
		);
	});

	it("redacts lines written before redaction existed when reading logs back", async () => {
		writeFileSync(
			state.logFile,
			`[info] ok\n[error] OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst\n[warn] ${SECRET}\n`,
		);
		const { getRecentLogs, generateDebugReport } = await import(
			"../app-logger"
		);

		const lines = getRecentLogs();

		expect(lines).toEqual([
			"[info] ok",
			"[error] OPENAI_API_KEY=[REDACTED]",
			"[warn] sk-ant-[REDACTED]",
		]);
		expect(generateDebugReport()).not.toContain("supersecretvalue");
	});
});
