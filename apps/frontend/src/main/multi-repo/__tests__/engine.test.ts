import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEngine } from "../../../shared/types";
import { ENGINE_FILE, parseTaskEngine, readEngine, writeEngine } from "../engine";

const trio = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" } as const;
const engine: TaskEngine = { spec: trio, planning: trio, coding: trio, qa: trio };

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "multi-repo-engine-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseTaskEngine", () => {
	it("answers null when no engine is given, so each project keeps its own", () => {
		expect(parseTaskEngine(undefined)).toBeNull();
		expect(parseTaskEngine(null)).toBeNull();
	});

	it("keeps a complete engine and trims the model", () => {
		const parsed = parseTaskEngine({
			...engine,
			coding: { provider: "copilot", model: "  gpt-5.5  ", effort: "low" },
		});
		expect(parsed).toEqual({ ...engine, coding: { provider: "copilot", model: "gpt-5.5", effort: "low" } });
	});

	it.each([
		["a list", [engine.spec]],
		["a missing phase", { spec: trio, planning: trio, coding: trio }],
		["an empty model", { ...engine, qa: { ...trio, model: " " } }],
		["a control character", { ...engine, qa: { ...trio, model: "a\u0007b" } }],
		["a model too long", { ...engine, qa: { ...trio, model: "m".repeat(201) } }],
		["an uppercase provider", { ...engine, spec: { ...trio, provider: "Anthropic" } }],
		["an unknown effort", { ...engine, spec: { ...trio, effort: "max" } }],
	])("refuses %s", (_label, raw) => {
		expect(parseTaskEngine(raw)).toBe("invalid");
	});
});

describe("engine.json", () => {
	it("round-trips the engine", () => {
		writeEngine(dir, engine);
		expect(readEngine(dir)).toEqual(engine);
	});

	it("reads no engine from a missing, unreadable or edited-out file", () => {
		expect(readEngine(dir)).toBeNull();
		writeFileSync(path.join(dir, ENGINE_FILE), "{not json", "utf-8");
		expect(readEngine(dir)).toBeNull();
		writeFileSync(path.join(dir, ENGINE_FILE), JSON.stringify({ spec: trio }), "utf-8");
		expect(readEngine(dir)).toBeNull();
	});
});
