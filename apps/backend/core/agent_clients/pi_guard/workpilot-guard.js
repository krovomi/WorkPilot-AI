/**
 * WorkPilot's write guard for pi (pi.dev), loaded with `-e` by the pi
 * provider (`core/agent_clients/pi_cli.py`).
 *
 * It mirrors, inside the pi process, the one barrier the SDK hooks put on
 * `Write`/`Edit` (`security/path_guard.py`): a file an agent writes must sit
 * inside the roots the build was given (the worktree, the spec directory, the
 * workpilot scratch directory), and the files that decide what an agent may do
 * (`.workpilot-allowlist`, `.workpilot-security.json`, `.workpilot/guardrails.*`,
 * `.claude/settings*.json`, pi's own `.pi/` and this guard) are refused even
 * inside them. It judges `write` and `edit` only: `bash` keeps the standing it
 * has on every other CLI WorkPilot drives (docs/architecture/pi.md, lot 4).
 *
 * The policy is not in this file. Python computes it from the same table the
 * SDK hooks use and hands it over as `WORKPILOT_PI_GUARD` (JSON), so the two
 * barriers cannot disagree on what they protect, and nothing in argv is a path.
 * Without a policy the guard fails closed: every write is refused and says why.
 *
 * Plain ESM on purpose — no import, no type — so pi loads it through jiti with
 * nothing to resolve.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const GUARDED_TOOLS = new Set(["write", "edit"]);

function readPolicy() {
	const raw = process.env.WORKPILOT_PI_GUARD;
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.roots)) return null;
		return {
			roots: parsed.roots.filter((r) => typeof r === "string" && r.length > 0),
			protectedNames: Array.isArray(parsed.protectedNames) ? parsed.protectedNames : [],
			protectedDirs: parsed.protectedDirs && typeof parsed.protectedDirs === "object" ? parsed.protectedDirs : {},
			protectedPrefixes: Array.isArray(parsed.protectedPrefixes) ? parsed.protectedPrefixes : [],
			caseInsensitive: parsed.caseInsensitive === true,
		};
	} catch {
		return null;
	}
}

/** The real path of `target`, following symlinks through its nearest existing ancestor. */
function canonical(target) {
	let probe = target;
	let rest = "";
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) return target;
		rest = rest ? `${probe.slice(parent.length + 1)}${sep}${rest}` : probe.slice(parent.length + 1);
		probe = parent;
	}
	const real = realpathSync.native ? realpathSync.native(probe) : realpathSync(probe);
	return rest ? resolve(real, rest) : real;
}

function fold(value, caseInsensitive) {
	return caseInsensitive ? value.toLowerCase() : value;
}

function isWithin(path, root, caseInsensitive) {
	const p = fold(path, caseInsensitive);
	const r = fold(root, caseInsensitive);
	return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** fnmatch's `*` and `?` only, which is all the protected-config table uses. */
function globMatch(name, pattern, caseInsensitive) {
	const source = `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`;
	return new RegExp(source, caseInsensitive ? "i" : "").test(name);
}

function protectedTarget(path, policy) {
	const parts = path.split(/[\\/]+/).filter(Boolean);
	if (parts.length === 0) return null;
	const name = parts[parts.length - 1];
	if (policy.protectedNames.some((p) => globMatch(name, p, policy.caseInsensitive))) return name;
	if (parts.length >= 2) {
		const dir = parts[parts.length - 2];
		for (const [directory, patterns] of Object.entries(policy.protectedDirs)) {
			if (!globMatch(dir, directory, policy.caseInsensitive)) continue;
			if (patterns.some((p) => globMatch(name, p, policy.caseInsensitive))) return `${dir}/${name}`;
		}
	}
	return null;
}

export default function (pi) {
	const policy = readPolicy();

	pi.on("tool_call", async (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const spelled = event.input && typeof event.input.path === "string" ? event.input.path : "";
		if (!policy) {
			return {
				block: true,
				reason: "WorkPilot's write guard has no policy (WORKPILOT_PI_GUARD is missing or invalid); writes are refused.",
			};
		}
		if (!spelled) {
			return { block: true, reason: `${event.toolName}: no path given.` };
		}
		const cwd = ctx && typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
		const target = canonical(isAbsolute(spelled) ? spelled : resolve(cwd, spelled));

		const guarded = protectedTarget(spelled, policy) ?? protectedTarget(target, policy);
		if (guarded) {
			return {
				block: true,
				reason: `Writing ${guarded} is refused: it decides what an agent may do. Ask the person to change it.`,
			};
		}
		for (const prefix of policy.protectedPrefixes) {
			if (isWithin(target, canonical(prefix), policy.caseInsensitive)) {
				return {
					block: true,
					reason: `Writing under ${prefix} is refused: it holds the agent's own guardrails.`,
				};
			}
		}
		if (!policy.roots.some((root) => isWithin(target, canonical(root), policy.caseInsensitive))) {
			return {
				block: true,
				reason: `Writing outside the build's directories is refused: ${spelled} resolves to ${target}. Allowed roots: ${policy.roots.join(", ")}.`,
			};
		}
		return undefined;
	});
}
