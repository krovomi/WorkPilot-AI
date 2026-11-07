import { isAuthReturn, redirectSystemPath } from "../app/+native-intent";
import { entraIdToken, entraIssuer } from "../auth/entra";

describe("Entra sign-in", () => {
	it("builds Microsoft's issuer from a tenant id or domain only", () => {
		expect(entraIssuer("contoso.onmicrosoft.com")).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0");
		expect(entraIssuer("0f1e2d3c-aaaa-bbbb-cccc-000000000000")).toContain("/0f1e2d3c-aaaa-bbbb-cccc-000000000000/v2.0");
		for (const bad of ["evil.com/../x", "a b", "", "x?y=1", "a#b"]) {
			expect(() => entraIssuer(bad)).toThrow("entra_misconfigured");
		}
	});

	it("refuses to start when the server has no Entra settings", async () => {
		await expect(entraIdToken({ local_enabled: true, entra_enabled: false })).rejects.toThrow("entra_disabled");
		await expect(
			entraIdToken({ local_enabled: true, entra_enabled: true, entra_tenant_id: "t", entra_client_id: null }),
		).rejects.toThrow("entra_disabled");
	});

	it("sends Microsoft's return link back to the app, and leaves other links alone", () => {
		for (const link of ["workpilot://auth?code=x&state=y", "/auth?code=x", "auth", "workpilot://auth/"]) {
			expect(isAuthReturn(link)).toBe(true);
			expect(redirectSystemPath({ path: link, initial: false })).toBe("/");
		}
		for (const link of ["/authors", "/projects/p1", "workpilot://settings", "/tokens"]) {
			expect(redirectSystemPath({ path: link, initial: true })).toBe(link);
		}
	});
});
