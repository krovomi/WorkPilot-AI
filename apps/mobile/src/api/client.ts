/**
 * The phone's connection to one WorkPilot server: the token pair, the
 * organization requests act in, and every request the app sends.
 *
 * The same rules as the desktop's `server-connection.ts`: the access token
 * goes in the `Authorization` header, the organization in `X-WorkPilot-Org`
 * (the server checks membership on every request, the header only selects),
 * and an expired access token is refreshed once, shared by every request
 * that saw the 401 at the same time — refreshing rotates the refresh token,
 * so a second concurrent refresh would fail and sign the person out.
 *
 * The class holds no storage of its own: whoever creates it persists the
 * refresh token it hands to `onTokens` (the Keychain or the Keystore, see
 * `auth/token-store.ts`) and learns from `onSignedOut` that it is gone.
 */

import type { TokenResponse } from "./types";

const TIMEOUT_MS = 20_000;
/** Server errors shown to a person are cut to this many characters. */
const MAX_ERROR = 300;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface ClientOptions {
	baseUrl: string;
	refreshToken?: string | null;
	orgId?: string | null;
	fetchImpl?: typeof fetch;
	/** A new pair was issued (sign-in, refresh, change of organization). */
	onTokens?: (tokens: TokenResponse) => void;
	/** The session is gone: the refresh token was refused. */
	onSignedOut?: () => void;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** The message of a failed response: the server's `detail` when it gives one. */
export function errorMessage(status: number, text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "detail" in parsed) {
			const detail = (parsed as { detail: unknown }).detail;
			if (typeof detail === "string" && detail) return detail.slice(0, MAX_ERROR);
		}
	} catch {
		// Not JSON: fall through to the status.
	}
	return `HTTP ${status}`;
}

export class ServerClient {
	readonly baseUrl: string;
	private accessToken: string | null = null;
	private refreshToken: string | null;
	private orgId: string | null;
	private refreshing: Promise<boolean> | null = null;
	private readonly fetchImpl: typeof fetch;
	private readonly onTokens?: (tokens: TokenResponse) => void;
	private readonly onSignedOut?: () => void;

	constructor(options: ClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.refreshToken = options.refreshToken ?? null;
		this.orgId = options.orgId ?? null;
		this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
		this.onTokens = options.onTokens;
		this.onSignedOut = options.onSignedOut;
	}

	get hasSession(): boolean {
		return !!this.refreshToken;
	}

	get activeOrgId(): string | null {
		return this.orgId;
	}

	/** The access token, for the live stream's handshake. */
	get currentAccessToken(): string | null {
		return this.accessToken;
	}

	/** Choose the organization requests act in; the server still checks it. */
	setOrg(orgId: string | null): void {
		this.orgId = orgId;
	}

	private async send(method: Method, path: string, body: unknown, auth: boolean): Promise<Response> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
		if (auth && this.orgId) headers["X-WorkPilot-Org"] = this.orgId;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			return await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			const aborted = err instanceof Error && err.name === "AbortError";
			throw new ApiError(0, aborted ? "timeout" : "network");
		} finally {
			clearTimeout(timer);
		}
	}

	private async parse<T>(res: Response): Promise<T> {
		const text = await res.text();
		if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, text));
		return (text ? JSON.parse(text) : null) as T;
	}

	private adopt(tokens: TokenResponse): void {
		this.accessToken = tokens.access_token;
		this.refreshToken = tokens.refresh_token;
		this.onTokens?.(tokens);
	}

	private forget(): void {
		const had = !!this.refreshToken;
		this.accessToken = null;
		this.refreshToken = null;
		this.orgId = null;
		if (had) this.onSignedOut?.();
	}

	/** A request without a session (the server's public routes). */
	async publicRequest<T>(method: Method, path: string, body?: unknown): Promise<T> {
		return this.parse<T>(await this.send(method, path, body, false));
	}

	/** A request as the signed-in person, refreshing an expired token once. */
	async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
		if (!this.accessToken && !(await this.refresh())) throw new ApiError(401, "signed_out");
		let res = await this.send(method, path, body, true);
		if (res.status === 401 && (await this.refresh())) {
			res = await this.send(method, path, body, true);
		}
		return this.parse<T>(res);
	}

	async login(email: string, password: string): Promise<TokenResponse> {
		const tokens = await this.publicRequest<TokenResponse>("POST", "/auth/login", { email, password });
		this.orgId = null;
		this.adopt(tokens);
		return tokens;
	}

	/**
	 * Exchange the refresh token for a new pair; one exchange at a time. False
	 * when there is no session or the server refused it (the person is then
	 * signed out); a network failure keeps the session for the next try.
	 */
	refresh(): Promise<boolean> {
		if (!this.refreshToken) return Promise.resolve(false);
		if (!this.refreshing) {
			const token = this.refreshToken;
			this.refreshing = (async () => {
				try {
					const res = await this.send("POST", "/auth/refresh", { refresh_token: token }, false);
					if (res.status === 401 || res.status === 403) {
						this.forget();
						return false;
					}
					this.adopt(await this.parse<TokenResponse>(res));
					return true;
				} catch (err) {
					if (err instanceof ApiError && err.status === 0) throw err;
					return false;
				} finally {
					this.refreshing = null;
				}
			})();
		}
		return this.refreshing;
	}

	/** Re-mint the pair for another organization the person belongs to. */
	async switchOrg(orgId: string): Promise<void> {
		const tokens = await this.request<TokenResponse>("POST", "/auth/switch-org", { org_id: orgId });
		this.orgId = orgId;
		this.adopt(tokens);
	}

	/** Revoke the refresh token on the server, then forget the session. */
	async logout(): Promise<void> {
		const token = this.refreshToken;
		try {
			if (token) await this.publicRequest("POST", "/auth/logout", { refresh_token: token });
		} catch {
			// Signing out on the phone must not depend on reaching the server.
		} finally {
			this.forget();
		}
	}
}
