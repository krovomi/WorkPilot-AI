/**
 * The current server session as the renderer shows it: who is signed in, how
 * the session was opened, and when. Display data only, as the server reports
 * it (`GET /auth/me/session`) and the main checks it; no token ever.
 */

/** How a session was opened: a password, Entra, the server's OpenID Connect provider, an invitation. */
export type ServerSignInMethod = "local" | "entra" | "oidc" | "invite";

export interface ServerSessionInfo {
	serverUrl: string;
	user: {
		email: string;
		displayName: string;
		role: string;
	};
	/** Null for a session from before the server named sign-ins. */
	method: ServerSignInMethod | null;
	/** The identity provider's name, for an Entra or OpenID Connect sign-in. */
	providerName: string | null;
	/** The host of that provider's issuer (`login.microsoftonline.com`, `idp.example.com`). */
	issuerHost: string | null;
	/** ISO date-time of the sign-in, when the server knows it. */
	signedInAt: string | null;
}
