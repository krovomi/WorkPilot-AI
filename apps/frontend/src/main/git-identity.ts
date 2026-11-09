/**
 * The author identity git needs before the first commit.
 *
 * A fresh machine has none: no `user.name` / `user.email`, and git refuses to
 * guess one ("Author identity unknown … Please tell me who you are"). The
 * "Initialize Git" button of a first start then failed with that raw message,
 * and every later commit an agent makes in a worktree would have failed the
 * same way. Asking `git var` mirrors git's own rule, auto-detection included,
 * and does not depend on the language git answers in.
 */
import { execFileSync } from "node:child_process";

export interface GitIdentity {
	name: string;
	email: string;
}

const MAX_FIELD = 200;

/** Whether git can name an author and a committer for a commit made in `cwd`. */
export function canGitCommit(
	git: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
		try {
			execFileSync(git, ["var", variable], {
				cwd,
				env,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * The identity the renderer sent, checked again here (the renderer is not
 * trusted): trimmed, short, one line, and an email that looks like one.
 */
export function parseGitIdentity(input: unknown): GitIdentity | null {
	if (!input || typeof input !== "object") return null;
	const { name, email } = input as Record<string, unknown>;
	if (typeof name !== "string" || typeof email !== "string") return null;
	const cleanName = name.trim();
	const cleanEmail = email.trim();
	// One printable line: a newline would write a second config entry, and
	// git itself rejects "<" and ">" in an identity.
	const oneLine = (value: string) =>
		value.length > 0 &&
		value.length <= MAX_FIELD &&
		![...value].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 0x20 || code === 0x7f || ch === "<" || ch === ">";
		});
	if (!oneLine(cleanName) || !oneLine(cleanEmail)) return null;
	if (!/^[^\s@]+@[^\s@]+$/.test(cleanEmail)) return null;
	return { name: cleanName, email: cleanEmail };
}

/**
 * Save the identity as the user's global git identity, which is what git's
 * own message asks for: the agents' commits in worktrees need it as well.
 */
export function saveGlobalGitIdentity(
	git: string,
	identity: GitIdentity,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const options = {
		env,
		encoding: "utf-8" as const,
		stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
	};
	execFileSync(git, ["config", "--global", "user.name", identity.name], options);
	execFileSync(git, ["config", "--global", "user.email", identity.email], options);
}
