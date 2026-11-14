#!/usr/bin/env node
/**
 * Audit what a packaged release lets anyone recover, before it is uploaded.
 *
 *   node scripts/release-exposure-audit.cjs --packaged [--fail-on high|medium|low]
 *
 * Runs REA's `audit-release-exposure` (npm `rea-agents`, the version pinned in
 * apps/backend/rea/pin.json) on the unpacked app electron-builder left in
 * `dist/`: shipped source maps, Electron fuses, debug companions, build paths,
 * credential markers. The audit is static: REA reads the files, never starts
 * the app and makes no network request (only npx fetches the pinned package).
 *
 * The install directory and the binary carrying the fuse wire are audited one
 * after the other. Each report is written to
 * dist/release-exposure/<platform>-<arch>-<install|executable>.json and its
 * table to $GITHUB_STEP_SUMMARY when it is set. The script exits 1 when a check is
 * `exposed` at the --fail-on severity or above (default high), or when the
 * audit could not finish. `unknown` and `not_assessed` never fail: they are
 * what static analysis could not decide, not a finding.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FRONTEND = path.resolve(__dirname, "..");
const PIN_FILE = path.resolve(FRONTEND, "..", "backend", "rea", "pin.json");
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };
const FAIL_LEVELS = ["high", "medium", "low"];
/** REA exits 3 when a completed audit has an exposed check at --fail_on. */
const REA_EXPOSED_EXIT = 3;
const AUDIT_TIMEOUT_MS = 15 * 60 * 1000;

function readPin(file = PIN_FILE) {
	const pin = JSON.parse(fs.readFileSync(file, "utf8"));
	if (pin.package !== "rea-agents" || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
		throw new Error(`${file}: expected package rea-agents and an exact x.y.z version`);
	}
	return pin;
}

function parseVersion(text) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
	return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, minimum) {
	for (let i = 0; i < 3; i += 1) {
		if (version[i] !== minimum[i]) return version[i] > minimum[i];
	}
	return true;
}

/** Whether `nodeVersion` meets one of the pin's `^x.y.z` / `>=x.y.z` ranges. */
function nodeSatisfies(nodeVersion, ranges) {
	const version = parseVersion(nodeVersion);
	if (!version) return false;
	return ranges.some((range) => {
		const match = /^(\^|>=)(\d+\.\d+\.\d+)$/.exec(range);
		if (!match) return false;
		const minimum = parseVersion(match[2]);
		if (match[1] === "^" && version[0] !== minimum[0]) return false;
		return atLeast(version, minimum);
	});
}

/**
 * What to audit for a platform, each as alternatives (the first that exists).
 *
 * The install directory (or the .app) holds the shipped JavaScript, source
 * maps, debug files and text. REA passes only four native images of a
 * directory to its fuse reader, and on Linux the app's own executable was not
 * one of them (fuses stayed `unknown`), so the binary that carries the fuse
 * wire is audited as well: the executable, or Electron Framework on macOS.
 */
function packagedTargets(platform, distDir, productName, executableName) {
	if (platform === "win32") {
		const dir = path.join(distDir, "win-unpacked");
		return [
			{ label: "install", candidates: [dir] },
			{ label: "executable", candidates: [path.join(dir, `${productName}.exe`)] },
		];
	}
	if (platform === "darwin") {
		const apps = ["mac", "mac-arm64", "mac-universal"].map((dir) =>
			path.join(distDir, dir, `${productName}.app`),
		);
		const framework = path.join(
			"Contents",
			"Frameworks",
			"Electron Framework.framework",
			"Versions",
			"A",
			"Electron Framework",
		);
		return [
			{ label: "install", candidates: apps },
			{ label: "executable", candidates: apps.map((app) => path.join(app, framework)) },
		];
	}
	const dir = path.join(distDir, "linux-unpacked");
	return [
		{ label: "install", candidates: [dir] },
		{
			label: "executable",
			candidates: [path.join(dir, executableName), path.join(dir, "workpilot-ai")],
		},
	];
}

/** npm's npx entry point next to this Node binary (no shell, no npx.cmd). */
function npxCli(execPath, exists = fs.existsSync) {
	const dir = path.dirname(execPath);
	const candidates = [
		path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
		path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
	];
	return candidates.find((candidate) => exists(candidate)) || null;
}

function auditArgs(pin, target, failOn) {
	return [
		"--yes",
		`${pin.package}@${pin.version}`,
		"audit-release-exposure",
		target,
		"--fail_on",
		failOn,
		"--json",
	];
}

/** The report inside REA's CLI output (an Evidence result keeps it under normalized_result). */
function extractReport(stdout) {
	const text = String(stdout).trim();
	const start = text.indexOf("{");
	if (start < 0) throw new Error("REA printed no JSON");
	const parsed = JSON.parse(text.slice(start));
	const report =
		parsed && typeof parsed === "object" && parsed.normalized_result
			? parsed.normalized_result
			: parsed;
	if (!report || !Array.isArray(report.checks)) {
		throw new Error("REA's JSON holds no release-exposure checks");
	}
	return report;
}

/** Checks exposed at `failOn` or above, computed from the report itself. */
function blockingChecks(report, failOn) {
	const floor = SEVERITY_RANK[failOn];
	return report.checks.filter(
		(check) =>
			check.status === "exposed" &&
			typeof check.severity === "string" &&
			SEVERITY_RANK[check.severity] >= floor,
	);
}

function markdownSummary(report, failOn, label) {
	const lines = [
		"",
		`### Release exposure (${label})`,
		"",
		`REA \`audit-release-exposure\`, failing on **${failOn}** and above. ` +
			"`unknown` and `not_assessed` are what static analysis could not decide.",
		"",
		"| Check | Status | Severity |",
		"| --- | --- | --- |",
	];
	for (const check of report.checks) {
		lines.push(`| \`${check.id}\` | ${check.status} | ${check.severity ?? ""} |`);
	}
	const exposed = report.checks.filter((check) => check.status === "exposed");
	for (const check of exposed) {
		lines.push("", `- **${check.id}**: ${check.remediation}`);
	}
	return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
	const index = argv.indexOf("--fail-on");
	const failOn = index >= 0 ? argv[index + 1] : "high";
	if (!FAIL_LEVELS.includes(failOn)) {
		throw new Error(`--fail-on must be one of ${FAIL_LEVELS.join(", ")}`);
	}
	if (!argv.includes("--packaged")) {
		throw new Error("pass --packaged: this script audits the unpacked app in dist/");
	}
	return { failOn };
}

function runAudit(pin, npx, target, failOn) {
	// npx resolves from a directory of its own: no project .npmrc or
	// node_modules decides what runs (REA's own advice for acquisition).
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workpilot-rea-"));
	try {
		const run = spawnSync(process.execPath, [npx, ...auditArgs(pin, target, failOn)], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: AUDIT_TIMEOUT_MS,
			shell: false,
		});
		if (run.error) throw run.error;
		if (run.status !== 0 && run.status !== REA_EXPOSED_EXIT) {
			process.stderr.write(run.stderr || "");
			throw new Error(`REA audit-release-exposure failed on ${target} (exit ${run.status})`);
		}
		return { report: extractReport(run.stdout), exposedExit: run.status === REA_EXPOSED_EXIT };
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function main() {
	const { failOn } = parseArgs(process.argv.slice(2));
	const pin = readPin();
	if (!nodeSatisfies(process.version, pin.node)) {
		throw new Error(
			`${pin.package}@${pin.version} needs Node.js ${pin.node.join(" || ")}; this is ${process.version}`,
		);
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8"));
	const productName = pkg.build?.productName || pkg.productName || pkg.name;
	const executableName = pkg.build?.linux?.executableName || pkg.name;
	const distDir = path.join(FRONTEND, "dist");
	const targets = packagedTargets(process.platform, distDir, productName, executableName).map(
		({ label, candidates }) => {
			const found = candidates.find((candidate) => fs.existsSync(candidate));
			if (!found) {
				throw new Error(`no packaged ${label} found; looked for:\n  ${candidates.join("\n  ")}`);
			}
			return { label, path: found };
		},
	);
	const npx = npxCli(process.execPath);
	if (!npx) throw new Error(`npx-cli.js not found next to ${process.execPath}`);

	const outDir = path.join(distDir, "release-exposure");
	fs.mkdirSync(outDir, { recursive: true });
	const blocking = [];
	let exposedExit = false;
	for (const target of targets) {
		const result = runAudit(pin, npx, target.path, failOn);
		const label = `${process.platform}-${process.arch}-${target.label}`;
		fs.writeFileSync(
			path.join(outDir, `${label}.json`),
			`${JSON.stringify(result.report, null, 2)}\n`,
		);
		const summary = markdownSummary(result.report, failOn, label);
		process.stdout.write(summary);
		if (process.env.GITHUB_STEP_SUMMARY) {
			fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
		}
		blocking.push(...blockingChecks(result.report, failOn).map((check) => check.id));
		exposedExit = exposedExit || result.exposedExit;
	}
	if (blocking.length > 0 || exposedExit) {
		const ids = [...new Set(blocking)].join(", ") || "(see REA output)";
		throw new Error(`the release exposes ${ids} at ${failOn} or above`);
	}
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`release-exposure-audit: ${error.message}\n`);
		process.exit(1);
	}
}

module.exports = {
	auditArgs,
	blockingChecks,
	extractReport,
	markdownSummary,
	nodeSatisfies,
	npxCli,
	packagedTargets,
	parseArgs,
	readPin,
};
