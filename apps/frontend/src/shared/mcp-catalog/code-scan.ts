/**
 * The static scan of an MCP server's published code (issue #369, lot 3).
 *
 * A closed list of patterns per language, run over the text of each source
 * file: nothing is parsed, compiled or run. The patterns lean towards
 * finding too much (a pattern in a string or a comment counts too): a false
 * positive the team has reviewed is accepted in the project's MCP policy,
 * with its reason. A credential-shaped string is reported by file and line
 * only; its value is never kept.
 *
 * Pure: the main process reads the archive (`main/mcp-security/`), this
 * module only reads text.
 */

import type { McpCodeFinding, McpCodeRule } from "../types/mcp-code-scan";

type Language = "js" | "py";

const LANGUAGE: Record<string, Language> = {
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "js",
	".ts": "js",
	".mts": "js",
	".cts": "js",
	".tsx": "js",
	".py": "py",
};

/** Folders whose code the server does not run. */
const NOT_RUN = /(^|\/)(tests?|__tests__|spec|examples?|docs?|\.github)\//i;
const DECLARATION = /\.d\.[cm]?ts$/i;

/** The language of a file worth scanning, or null. */
export function sourceLanguage(file: string): Language | null {
	if (DECLARATION.test(file) || NOT_RUN.test(file)) return null;
	const dot = file.lastIndexOf(".");
	if (dot < 0 || dot < file.lastIndexOf("/")) return null;
	return LANGUAGE[file.slice(dot).toLowerCase()] ?? null;
}

// Shapes of real credentials only (prefix and length): a generic
// `password = …` would be every server's configuration code.
const SECRET = [
	/\bsk-ant-[A-Za-z0-9_-]{20,}/g,
	/\bsk-[A-Za-z0-9]{32,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{40,}/g,
	/\bglpat-[A-Za-z0-9_-]{20}\b/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
];

const RULES: Record<Language, Record<McpCodeRule, RegExp[]>> = {
	js: {
		shellExec: [
			/\bchild_process\b/g,
			/(?<![\w$.])(execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/g,
			/\brequire\s*\(\s*["'](execa|shelljs|cross-spawn)["']\s*\)/g,
			/\bfrom\s+["'](execa|shelljs|cross-spawn)["']/g,
		],
		dynamicCode: [
			/(?<![\w$.])eval\s*\(/g,
			/\bnew\s+Function\s*\(/g,
			/\bvm\.(runInNewContext|runInThisContext|runInContext|compileFunction|Script)\b/g,
			/\brequire\s*\(\s*(?![\s"'`)])/g,
			/(?<![\w$.])import\s*\(\s*(?![\s"'`)])/g,
		],
		network: [
			/(?<![\w$.])fetch\s*\(/g,
			/\bhttps?\.(request|get)\s*\(/g,
			/\bnet\.(connect|createConnection)\s*\(/g,
			/\bnew\s+WebSocket\s*\(/g,
			/\b(axios|undici|node-fetch|got)\b/g,
		],
		fileWrite: [
			/\b(writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|createWriteStream)(Sync)?\s*\(/g,
		],
		hardcodedSecret: SECRET,
	},
	py: {
		shellExec: [
			/\bsubprocess\.(run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\b/g,
			/\bfrom\s+subprocess\s+import\b/g,
			/\bos\.(system|popen|exec[lv]p?e?|spawn[lv]p?e?)\s*\(/g,
			/\basyncio\.create_subprocess_(exec|shell)\b/g,
			/\bpty\.spawn\b/g,
		],
		dynamicCode: [
			/(?<![\w.])eval\s*\(/g,
			/(?<![\w.])exec\s*\(/g,
			/(?<![\w.])__import__\s*\(/g,
			/\bimportlib\.import_module\s*\(\s*(?![\s"')])/g,
			/\bmarshal\.loads\b/g,
		],
		network: [
			/\b(requests|httpx|aiohttp|urllib3)\.\w+/g,
			/\burllib\.request\b/g,
			/\bsocket\.(socket|create_connection)\s*\(/g,
		],
		fileWrite: [
			/\bshutil\.(rmtree|move|copy\w*)\s*\(/g,
			/\bos\.(remove|unlink|rmdir|removedirs|rename|replace)\s*\(/g,
			/\.(write_text|write_bytes|unlink|rmdir)\s*\(/g,
			/(?<![\w.])open\s*\([^)\n]*["'][rwxa]?[wxa]b?\+?["']/g,
		],
		hardcodedSecret: SECRET,
	},
};

/** Every rule, the riskiest first. */
export const CODE_RULES: readonly McpCodeRule[] = [
	"shellExec",
	"dynamicCode",
	"hardcodedSecret",
	"fileWrite",
	"network",
];

const MAX_FILE_TEXT = 200;
/** A file name as it may be shown: no control character, bounded. */
export function displayPath(file: string): string {
	let shown = "";
	for (const char of file.slice(0, MAX_FILE_TEXT)) {
		const code = char.charCodeAt(0);
		shown += code < 32 || code === 127 ? "?" : char;
	}
	return shown;
}

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) {
		line++;
	}
	return line;
}

/** What `rules` find in one file: one finding per rule, with its first line. */
export function scanFile(file: string, text: string): McpCodeFinding[] {
	const language = sourceLanguage(file);
	if (!language) return [];
	const findings: McpCodeFinding[] = [];
	for (const rule of CODE_RULES) {
		let count = 0;
		let first = -1;
		for (const pattern of RULES[language][rule]) {
			pattern.lastIndex = 0;
			for (const match of text.matchAll(pattern)) {
				count++;
				if (first < 0 || match.index < first) first = match.index;
			}
		}
		if (count) findings.push({ rule, file: displayPath(file), line: lineAt(text, first), count });
	}
	return findings;
}

/** At most this many findings are kept, the riskiest rules first. */
export const MAX_FINDINGS = 60;

/** The findings of a whole package, riskiest rules first, bounded. */
export function scanSources(files: Iterable<{ path: string; text: string }>): McpCodeFinding[] {
	const all: McpCodeFinding[] = [];
	for (const file of files) all.push(...scanFile(file.path, file.text));
	const order = (rule: McpCodeRule) => CODE_RULES.indexOf(rule);
	return all
		.sort((a, b) => order(a.rule) - order(b.rule) || a.file.localeCompare(b.file))
		.slice(0, MAX_FINDINGS);
}
