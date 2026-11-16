/**
 * PowerShell single-quoted strings.
 *
 * Inside '…' PowerShell interprets nothing but the quote that closes the
 * string, and a doubled quote stands for one. PowerShell reads four more
 * characters as that quote: ‘ ’ ‚ ‛ (U+2018 to U+201B). Each one is doubled
 * here like the ASCII apostrophe, as PowerShell's own
 * CodeGeneration.EscapeSingleQuotedStringContent does.
 */
const SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

/** The content of a single-quoted string, without the surrounding quotes. */
export function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(SINGLE_QUOTES, "$&$&");
}

/** `value` as a PowerShell single-quoted string literal. */
export function quotePowerShellSingle(value: string): string {
	return `'${escapePowerShellSingleQuoted(value)}'`;
}
