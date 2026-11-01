/**
 * Links the system opens the app with, before the router sees them. Microsoft
 * sends the person back to `workpilot://auth` after an Entra sign-in; the
 * sign-in screen reads that answer itself (`auth/entra.ts`), so the link only
 * goes back to where the person is. A route for it would sit outside the
 * sign-in guard and bounce a signed-out person between it and `/`.
 */

export function isAuthReturn(path: string): boolean {
	return /^(workpilot:\/\/)?\/?auth(?:[/?#]|$)/.test(path);
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	return isAuthReturn(path) ? "/" : path;
}
