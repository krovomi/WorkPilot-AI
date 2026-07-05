import type { TFunction } from "i18next";

/**
 * Localise the **status log lines** the backend writes into task_logs.json.
 *
 * The log feed is otherwise shown raw (it's mostly English backend traces + the
 * model's own output). A small, known set of status messages — QA pass verdicts,
 * hot-swap traces, the model-unavailable halt, the LLM context switch — are
 * emitted by the backend in **stable English** on purpose, so they can be
 * mapped here to `tasks:execution.logMessages.*` i18n keys and displayed in the
 * user's language (same idea as {@link translateActivityMessage}, applied to the
 * feed). Anything that doesn't match a known pattern is returned unchanged.
 */

// --- Full-message patterns (whole line → one key, with params) --------------

const QA_COVERAGE = /^QA pass #(\d+) rejected by the coverage gate/;
const QA_ARCH = /^QA pass #(\d+) rejected: (\d+) architecture violation/;
const QA_ISSUES = /^QA pass #(\d+) rejected: (\d+) issue/;
const QA_APPROVED = /^QA pass #(\d+) approved:/;
const QA_MANUAL =
	/^QA pass #(\d+): code validated by review; manual verification required( \(environment limitation[^)]*\))?/;
const MODEL_UNAVAILABLE = /^Unavailable model: (.+?)\. Phase halted/;
const HOT_SWAP_RESUMED = /^Hot LLM swap — resuming with the new model/;

// --- Token replacements (composite lines: translate labels, keep values) -----
// Applied in order; each replaces a stable English token with its localised form.
function tokenReplacements(t: TFunction): Array<[RegExp, string]> {
	const L = (k: string) => t(`tasks:execution.logMessages.${k}`);
	return [
		[/🔄 Hot swap \(/, `🔄 ${L("hotSwapLabel")} (`],
		[/🔄 LLM context switch —/, `🔄 ${L("ctxSwitchLabel")} —`],
		[/▶️ Initial LLM context —/, `▶️ ${L("ctxInitialLabel")} —`],
		// Labels shared by hot-swap ("Provider → x") and context switch
		// ("Provider: a → b"). Anchored on the trailing separator so we never
		// touch a value that happens to contain the word.
		[/\bProvider(?=[ ]*[→:])/g, L("provider")],
		[/\bModel(?=[ ]*[→:])/g, L("model")],
		[/\bEffort(?=[ ]*[→:])/g, L("effort")],
	];
}

export function translateLogMessage(
	t: TFunction,
	content: string | null | undefined,
): string {
	if (!content) return content ?? "";
	const s = content.trim();

	let m: RegExpMatchArray | null;

	if ((m = s.match(QA_COVERAGE))) {
		const n = Number(m[1]);
		return t("tasks:execution.logMessages.qaCoverageRejected", {
			n,
			next: n + 1,
		});
	}
	if ((m = s.match(QA_ARCH))) {
		const n = Number(m[1]);
		return t("tasks:execution.logMessages.qaArchRejected", {
			n,
			count: Number(m[2]),
			next: n + 1,
		});
	}
	if ((m = s.match(QA_ISSUES))) {
		const n = Number(m[1]);
		return t("tasks:execution.logMessages.qaRejected", {
			n,
			count: Number(m[2]),
			next: n + 1,
		});
	}
	if ((m = s.match(QA_APPROVED))) {
		return t("tasks:execution.logMessages.qaApproved", { n: Number(m[1]) });
	}
	if ((m = s.match(QA_MANUAL))) {
		const key = m[2]
			? "qaManualVerificationSandbox"
			: "qaManualVerification";
		return t(`tasks:execution.logMessages.${key}`, { n: Number(m[1]) });
	}
	if ((m = s.match(MODEL_UNAVAILABLE))) {
		return t("tasks:execution.logMessages.modelUnavailable", { model: m[1] });
	}
	if (HOT_SWAP_RESUMED.test(s)) {
		return t("tasks:execution.logMessages.hotSwapResumed");
	}

	// Composite lines: localise the known tokens, keep the dynamic values.
	if (
		content.includes("🔄 Hot swap (") ||
		content.includes("🔄 LLM context switch") ||
		content.includes("▶️ Initial LLM context")
	) {
		let out = content;
		for (const [re, repl] of tokenReplacements(t)) out = out.replace(re, repl);
		return out;
	}

	return content;
}
