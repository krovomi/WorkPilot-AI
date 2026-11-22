import { toMySession } from "../auth/my-session";

describe("toMySession", () => {
	it("keeps the method, the provider, its issuer's host and the sign-in time", () => {
		expect(
			toMySession({
				method: "oidc",
				provider_name: "  Okta  ",
				issuer_host: "acme.okta.com",
				signed_in_at: "2026-11-02T16:30:00Z",
				login_id: "login-1",
			}),
		).toEqual({
			method: "oidc",
			providerName: "Okta",
			issuerHost: "acme.okta.com",
			signedInAt: "2026-11-02T16:30:00Z",
		});
	});

	it("drops what is not of a known shape", () => {
		expect(
			toMySession({
				method: "magic",
				provider_name: "x".repeat(81),
				issuer_host: "evil host/<script>",
				signed_in_at: "yesterday",
			}),
		).toEqual({ method: null, providerName: null, issuerHost: null, signedInAt: null });
		expect(
			toMySession({ method: 3, provider_name: "Ok\u0007ta", issuer_host: "   ", signed_in_at: 12 }),
		).toEqual({ method: null, providerName: null, issuerHost: null, signedInAt: null });
	});

	it("reads a session from before sign-ins were named as no method", () => {
		expect(toMySession({ method: null })).toEqual({
			method: null,
			providerName: null,
			issuerHost: null,
			signedInAt: null,
		});
	});

	it("gives nothing for an answer that is not an object", () => {
		expect(toMySession(null)).toBeNull();
		expect(toMySession("session")).toBeNull();
	});
});
