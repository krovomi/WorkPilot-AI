import { describe, expect, it } from "vitest";
import {
	CODE_RULES,
	displayPath,
	MAX_FINDINGS,
	scanFile,
	scanSources,
	sourceLanguage,
} from "../code-scan";

const rules = (file: string, text: string) => scanFile(file, text).map((f) => f.rule);

describe("sourceLanguage", () => {
	it("reads JavaScript, TypeScript and Python files the server runs", () => {
		expect(sourceLanguage("dist/index.js")).toBe("js");
		expect(sourceLanguage("src/server.MTS")).toBe("js");
		expect(sourceLanguage("pkg/server.py")).toBe("py");
	});

	it("leaves out declarations, tests, examples, other files and names without an extension", () => {
		expect(sourceLanguage("dist/index.d.ts")).toBeNull();
		expect(sourceLanguage("test/run.js")).toBeNull();
		expect(sourceLanguage("pkg/tests/test_x.py")).toBeNull();
		expect(sourceLanguage("examples/demo.py")).toBeNull();
		expect(sourceLanguage("README.md")).toBeNull();
		expect(sourceLanguage("bin/server")).toBeNull();
		expect(sourceLanguage("dir.v2/server")).toBeNull();
	});
});

describe("scanFile", () => {
	it("finds each JavaScript rule", () => {
		expect(rules("a.js", 'const cp = require("child_process");')).toContain("shellExec");
		expect(rules("a.js", "spawnSync('ls')")).toEqual(["shellExec"]);
		expect(rules("a.js", 'import { execa } from "execa";')).toEqual(["shellExec"]);
		expect(rules("a.js", "eval(code)")).toEqual(["dynamicCode"]);
		expect(rules("a.js", "new Function(body)")).toEqual(["dynamicCode"]);
		expect(rules("a.js", "vm.runInNewContext(x)")).toEqual(["dynamicCode"]);
		expect(rules("a.js", "require(name)")).toEqual(["dynamicCode"]);
		expect(rules("a.js", "await import(plugin)")).toEqual(["dynamicCode"]);
		expect(rules("a.js", "await fetch(url)")).toEqual(["network"]);
		expect(rules("a.js", "fs.writeFileSync(p, x)")).toEqual(["fileWrite"]);
		expect(rules("a.js", "const k = '-----BEGIN PRIVATE KEY-----'")).toEqual(["hardcodedSecret"]);
	});

	it("does not take a literal import, a method named eval or regex exec for a risk", () => {
		expect(rules("a.js", 'require("./util"); await import("./x.js");')).toEqual([]);
		expect(rules("a.js", "page.$eval(sel); re.exec(text); obj.spawn = 1")).toEqual([]);
	});

	it("finds each Python rule", () => {
		expect(rules("a.py", "subprocess.run(['ls'])")).toEqual(["shellExec"]);
		expect(rules("a.py", "os.system(cmd)")).toEqual(["shellExec"]);
		expect(rules("a.py", "exec(source)")).toEqual(["dynamicCode"]);
		expect(rules("a.py", "importlib.import_module(name)")).toEqual(["dynamicCode"]);
		expect(rules("a.py", "httpx.get(url)")).toEqual(["network"]);
		expect(rules("a.py", "open(path, 'w')")).toEqual(["fileWrite"]);
		expect(rules("a.py", "cursor.exec(q); importlib.import_module('json'); open(p)")).toEqual([]);
	});

	it("gives the line of the first match and the count, never the credential", () => {
		const token = `gh${"p_"}${"a".repeat(36)}`;
		const text = `ok\nconst a = "${token}";\nconst b = "${token}";\n`;
		const [finding] = scanFile("src/a.ts", text);
		expect(finding).toEqual({ rule: "hardcodedSecret", file: "src/a.ts", line: 2, count: 2 });
		expect(JSON.stringify(finding)).not.toContain(token);
	});

	it("counts every pattern of a rule and keeps the earliest line", () => {
		const [finding] = scanFile("a.js", "\n\nexecSync(a)\nconst c = require('child_process')");
		expect(finding).toMatchObject({ rule: "shellExec", line: 3, count: 2 });
	});

	it("reads nothing in a file that is not code", () => {
		expect(scanFile("README.md", "eval(x)")).toEqual([]);
	});
});

describe("displayPath", () => {
	it("replaces control characters and bounds the length", () => {
		expect(displayPath("a\u001b[31m\u007f.js")).toBe("a?[31m?.js");
		expect(displayPath("x".repeat(500))).toHaveLength(200);
	});
});

describe("scanSources", () => {
	it("puts the riskiest rules first, then sorts by file", () => {
		const findings = scanSources([
			{ path: "b.js", text: "fetch(u)" },
			{ path: "a.js", text: "fetch(u); eval(x)" },
			{ path: "c.js", text: "execSync(c)" },
		]);
		expect(findings.map((f) => `${f.rule}:${f.file}`)).toEqual([
			"shellExec:c.js",
			"dynamicCode:a.js",
			"network:a.js",
			"network:b.js",
		]);
		expect(CODE_RULES[0]).toBe("shellExec");
	});

	it("keeps at most MAX_FINDINGS", () => {
		const files = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) => ({
			path: `f${i}.js`,
			text: "fetch(u)",
		}));
		expect(scanSources(files)).toHaveLength(MAX_FINDINGS);
	});
});
