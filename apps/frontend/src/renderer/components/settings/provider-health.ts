/**
 * Whether a provider card counts as working, failing or neither.
 *
 * A provider that is not configured is neither: `isWorking` false painted it
 * red and counted it in « N provider(s) with errors », so a fresh install
 * opened Settings → Accounts (and the setup wizard) on « 15 errors ».
 * A configured provider switched off for auto-switching stays `false`, as
 * before.
 */
export function providerIsWorking(
	configured: boolean | undefined,
	enabled: boolean,
): boolean | undefined {
	return configured ? enabled : undefined;
}
