/**
 * Whether an edited subject follows the project's convention (#360), the same
 * test as `git_surgeon/conventions.py` for Conventional Commits and gitmoji.
 * A custom pattern is the project's own regular expression: it is only run by
 * the backend, so an edited message keeps the backend's verdict there.
 */
import type { CommitConvention, RewritePlan, RewriteStep } from "../../../shared/types/git-surgeon";

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s]{1,40}\))?!?: \S/;
const GITMOJI = /^(:[a-z0-9_+-]{1,40}:|[☀-➿]|[\u{1f300}-\u{1faff}])️?\s+\S/u;
const VAGUE =
	/^(wip|fixup|tmp|temp|test|tests|asdf|qwe|xxx|todo|hack|stuff|updates?|updated|changes?|fix(es|ed)?|minor|misc|cleanup|clean up|typo|oops|more|again|review|lint|format|\W*)\W*$/i;

export function conformsTo(subject: string, convention: CommitConvention): boolean | null {
	const text = subject.trim();
	const rest = CONVENTIONAL.test(text) ? text.split(": ").slice(1).join(": ") : text;
	if (!text || text.length > 100 || VAGUE.test(text) || VAGUE.test(rest) || rest.length < 4) return false;
	if (convention.kind === "custom") return null;
	return (convention.kind === "gitmoji" ? GITMOJI : CONVENTIONAL).test(text);
}

/** The share of steps whose subject follows the convention, as the page shows them. */
export function readabilityOf(steps: RewriteStep[], plan: RewritePlan): number | null {
	if (steps.length === 0) return null;
	const scored = new Map(plan.plan.map((s) => [s.id, s]));
	let ok = 0;
	for (const step of steps) {
		const original = scored.get(step.id);
		const subject = step.message.split("\n", 1)[0];
		const verdict =
			original && original.message === step.message
				? Boolean(original.conforms)
				: (conformsTo(subject, plan.convention) ?? Boolean(original?.conforms));
		if (verdict) ok += 1;
	}
	return Math.round((100 * ok) / steps.length);
}
