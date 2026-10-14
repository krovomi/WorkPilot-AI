/**
 * Secret redaction for anything written to a log.
 *
 * Two nets, because neither is enough alone:
 * - by shape: provider key formats (`sk-ant-…`, `ghp_…`, `AIza…`, JWTs…),
 *   `Bearer …` credentials and `user:password@` in URLs, wherever they appear;
 * - by name: the value next to a sensitive name, in text (`api_key=…`,
 *   `"token": "…"`, `ANTHROPIC_API_KEY=…`) or as an object key (`apiKey`,
 *   `authorization`, `refreshToken`…).
 *
 * Idempotent: redacted output passes through unchanged.
 */

export const REDACTED = "[REDACTED]";

/**
 * Recognisable credential formats. The first group — the prefix — is kept:
 * it tells a reader what leaked without leaking it.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
	// Anthropic, then OpenAI, OpenRouter, DeepSeek and other `sk-` keys
	/\b(sk-ant-)[A-Za-z0-9_-]{8,}/g,
	/\b(sk-)[A-Za-z0-9_-]{16,}/g,
	// GitHub tokens (classic, OAuth, app, refresh) and fine-grained PATs
	/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g,
	/\b(github_pat_)[A-Za-z0-9_]{20,}/g,
	// GitLab personal, deploy, runner, OAuth… tokens
	/\b(gl(?:pat|dt|rt|ptt|ft|oas|cbt|imt|soat|agent)-)[A-Za-z0-9_-]{16,}/g,
	// Slack, Google, Groq, xAI, Hugging Face, Linear, Atlassian
	/\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g,
	/\b(AIza)[0-9A-Za-z_-]{30,}/g,
	/\b(gsk_)[A-Za-z0-9]{20,}/g,
	/\b(xai-)[A-Za-z0-9]{20,}/g,
	/\b(hf_)[A-Za-z0-9]{20,}/g,
	/\b(lin_(?:api|oauth)_)[A-Za-z0-9]{20,}/g,
	/\b(ATATT)[A-Za-z0-9_=-]{20,}/g,
	// AWS access key ids
	/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
	// JSON Web Tokens
	/\b(eyJ)[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `Authorization: Bearer <token>` / `Basic <credentials>`. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** `https://user:password@host` — the password goes, the user stays. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;

/**
 * A sensitive name followed by `=` or `:` and a value. The name may be quoted
 * (JSON) or an environment variable; the value stops at a quote, a separator
 * or whitespace. Literal booleans and null are left alone (`hasToken: true`).
 */
const NAMED_VALUE =
	/(["']?\b[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|access[_-]?key|secret|password|passwd|passphrase|token|credentials?)["']?\s*[:=]\s*["']?)(?!(?:true|false|null|undefined)\b)([^\s"'&,;)}[\]]{4,})/gi;

/** Object keys whose string value is a credential. */
const SENSITIVE_KEY =
	/(?:api[_-]?key|apikey|access[_-]?key|secret|password|passwd|passphrase|token|authorization|cookie|credentials?|private[_-]?key)$/i;

/** Mask every credential found in `text`. */
export function redactSecrets(text: string): string {
	if (!text) return text;
	// URL credentials before named values, or `x-access-token:` would take the
	// host with it. Named values before shapes: `API_KEY=sk-…` loses the whole
	// value, not just the part a token shape would have recognised.
	let result = text
		.replace(URL_CREDENTIALS, `$1:${REDACTED}@`)
		.replace(NAMED_VALUE, `$1${REDACTED}`)
		.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
	for (const pattern of TOKEN_SHAPES) {
		result = result.replace(pattern, `$1${REDACTED}`);
	}
	return result;
}

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key);
}

const MAX_DEPTH = 8;

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of `value` safe to log: strings redacted, sensitive object keys
 * masked, Errors rebuilt with a redacted message and stack. Never mutates its
 * input. Class instances other than Error are passed through as they are.
 */
export function redactValue(value: unknown): unknown {
	return redact(value, 0, new WeakSet());
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value) || depth >= MAX_DEPTH) return value;
	seen.add(value);

	if (value instanceof Error) {
		const copy = new Error(redactSecrets(value.message));
		copy.name = value.name;
		copy.stack = value.stack ? redactSecrets(value.stack) : undefined;
		for (const [key, field] of Object.entries(value)) {
			(copy as unknown as Record<string, unknown>)[key] = redactField(
				key,
				field,
				depth,
				seen,
			);
		}
		return copy;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redact(item, depth + 1, seen));
	}
	if (!isPlainObject(value)) return value;

	const result: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) {
		result[key] = redactField(key, field, depth, seen);
	}
	return result;
}

function redactField(
	key: string,
	field: unknown,
	depth: number,
	seen: WeakSet<object>,
): unknown {
	if (typeof field === "string" && field !== "" && isSensitiveKey(key)) {
		return REDACTED;
	}
	return redact(field, depth + 1, seen);
}
