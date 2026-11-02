/**
 * Links the system opens the app with, before the router sees them. Microsoft
 * sends the person back to `workpilot://auth` after an Entra sign-in; the
 * sign-in screen reads that answer itself (`auth/entra.ts`), so the link only
 * goes back to where the person is. A route for it would sit outside the
 * sign-in guard and bounce a signed-out person between it and `/`.
 *
 * A share from another app opens `workpilot://expo-sharing` (`expo-sharing`):
 * it goes to `/share`, inside the sign-in guard, which reads what was shared.
 * Only the link's name is matched; the shared text never reaches the router.
 */

export function isAuthReturn(path: string): boolean {
	return /^(workpilot:\/\/)?\/?auth(?:[/?#]|$)/.test(path);
}

export function isShareIntent(path: string): boolean {
	return /^(workpilot:\/\/)?\/?expo-sharing(?:[/?#]|$)/.test(path);
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
	if (isAuthReturn(path)) return "/";
	return isShareIntent(path) ? "/share" : path;
}
