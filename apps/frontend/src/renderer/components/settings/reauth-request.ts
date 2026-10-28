/**
 * Hand-off between the re-auth toast and Settings → Accounts.
 *
 * The toast is rendered before the Accounts section mounts, so a plain event
 * would be lost: the request is kept until the section consumes it, and an
 * event covers the case where the section is already on screen.
 */

const REAUTH_REQUEST_EVENT = "workpilot:provider-reauth-request";

let pendingProviderId: string | null = null;

/** Ask Settings → Accounts to start the login flow for this provider. */
export function requestProviderReauth(providerId: string): void {
	pendingProviderId = providerId;
	globalThis.dispatchEvent(
		new CustomEvent<string>(REAUTH_REQUEST_EVENT, { detail: providerId }),
	);
}

/** Take the pending request, if any; it is answered at most once. */
export function consumeProviderReauthRequest(): string | null {
	const providerId = pendingProviderId;
	pendingProviderId = null;
	return providerId;
}

/** Be told when a request arrives while the Accounts section is mounted. */
export function onProviderReauthRequest(listener: () => void): () => void {
	globalThis.addEventListener(REAUTH_REQUEST_EVENT, listener);
	return () => globalThis.removeEventListener(REAUTH_REQUEST_EVENT, listener);
}
