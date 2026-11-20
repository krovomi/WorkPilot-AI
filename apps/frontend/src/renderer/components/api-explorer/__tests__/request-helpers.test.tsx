/**
 * The pure pieces behind a request: the Basic header, the token of a sign-in
 * answer, the OAuth 2.0 token request, the body example, and the shared
 * highlighting and $ref helpers.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REQUEST_AUTH,
	type OpenApiSpec,
} from "../../../stores/api-explorer-store";
import {
	escapeHtml,
	getStatusColor,
	MethodBadge,
	prettifyXml,
	resolveRef,
	syntaxHighlightJson,
} from "../api-explorer-shared";
import {
	buildExampleFromSchema,
	getBodyPlaceholder,
	SchemaViewer,
} from "../RequestPanel";
import { CustomSelect } from "../request-controls";
import {
	basicAuthHeader,
	findResponseToken,
	requestOAuth2Token,
} from "../request-auth";

const SPEC: OpenApiSpec = {
	openapi: "3.0.0",
	info: { title: "Shop", version: "1" },
	paths: {},
	components: {
		schemas: {
			User: {
				type: "object",
				required: ["id"],
				properties: {
					id: { type: "integer", description: "The id" },
					name: { type: "string" },
					role: { type: "string", enum: ["admin", "member"] },
					active: { type: "boolean" },
					tags: { type: "array", items: { type: "string" } },
					manager: { $ref: "#/components/schemas/User" },
				},
			},
			"a/b": { type: "string", example: "slashed" },
			Named: { type: "object", example: { from: "schema" } },
		},
	},
} as OpenApiSpec;

describe("basicAuthHeader", () => {
	it("encodes the credentials as UTF-8 Base64", () => {
		expect(basicAuthHeader("ada", "pw")).toBe(`Basic ${btoa("ada:pw")}`);
		// btoa alone throws on these.
		expect(basicAuthHeader("émile", "mot€")).toBe("Basic w6ltaWxlOm1vdOKCrA==");
	});
});

describe("findResponseToken", () => {
	it("takes the first usual field long enough to be a token", () => {
		expect(findResponseToken('{"token":"short","jwt":"aaaaaaaaaaaa"}', 200)).toBe("aaaaaaaaaaaa");
		expect(findResponseToken('{"access_token":"bbbbbbbbbbbb"}', 201)).toBe("bbbbbbbbbbbb");
	});

	it("finds none in an error, a non-object or text", () => {
		expect(findResponseToken('{"token":"aaaaaaaaaaaa"}', 401)).toBeNull();
		expect(findResponseToken('{"token":"aaaaaaaaaaaa"}', 302)).toBeNull();
		expect(findResponseToken('{"token":"aaaaaaaaaaaa"}', null)).toBeNull();
		expect(findResponseToken("", 200)).toBeNull();
		expect(findResponseToken("null", 200)).toBeNull();
		expect(findResponseToken("<html>", 200)).toBeNull();
		expect(findResponseToken('{"token":42}', 200)).toBeNull();
	});
});

describe("requestOAuth2Token", () => {
	const proxyHttpRequest = vi.fn();
	beforeEach(() => {
		proxyHttpRequest.mockReset();
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = { proxyHttpRequest };
	});
	afterEach(() => {
		delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
	});
	const auth = { ...DEFAULT_REQUEST_AUTH, oauth2TokenUrl: "https://auth.shop.com/token" };

	it("posts the form through the main process and gives the token", async () => {
		proxyHttpRequest.mockResolvedValue({ success: true, status: 200, body: '{"access_token":"at"}' });
		await expect(
			requestOAuth2Token({ ...auth, oauth2ClientId: "id", oauth2ClientSecret: "test-secret-0000", oauth2Scope: "read" }),
		).resolves.toEqual({ token: "at" });

		const [call] = proxyHttpRequest.mock.calls[0];
		expect(call).toMatchObject({
			url: "https://auth.shop.com/token",
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});
		expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
			grant_type: "client_credentials",
			client_id: "id",
			client_secret: "test-secret-0000",
			scope: "read",
		});
	});

	it("sends the person's credentials for the password grant only", async () => {
		proxyHttpRequest.mockResolvedValue({ success: true, status: 200, body: "{}" });
		await requestOAuth2Token({ ...auth, oauth2GrantType: "password", username: "ada", password: "pw" });
		expect(Object.fromEntries(new URLSearchParams(proxyHttpRequest.mock.calls[0][0].body))).toEqual({
			grant_type: "password",
			username: "ada",
			password: "pw",
		});
	});

	it("names the error the endpoint or the request gave", async () => {
		proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 400, body: '{"error":"invalid_client","error_description":"Unknown client"}' });
		await expect(requestOAuth2Token(auth)).resolves.toEqual({ error: "Unknown client" });
		proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 400, body: '{"error":"invalid_grant"}' });
		await expect(requestOAuth2Token(auth)).resolves.toEqual({ error: "invalid_grant" });
		proxyHttpRequest.mockResolvedValueOnce({ success: false, error: "ECONNREFUSED" });
		await expect(requestOAuth2Token(auth)).resolves.toEqual({ error: "ECONNREFUSED" });
		proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 500, body: "<html>" });
		await expect(requestOAuth2Token(auth)).resolves.toEqual({ error: null });
	});
});

describe("getBodyPlaceholder", () => {
	const post = (content: Record<string, unknown> | undefined) =>
		({ requestBody: content === undefined ? undefined : { content } }) as never;

	it("prefers the media example, then the schema's, then one built from it", () => {
		expect(getBodyPlaceholder(post({ "application/json": { example: { a: 1 } } }), SPEC)).toBe('{\n  "a": 1\n}');
		expect(getBodyPlaceholder(post({ "application/json": { schema: { $ref: "#/components/schemas/Named" } } }), SPEC)).toBe('{\n  "from": "schema"\n}');
		expect(getBodyPlaceholder(post({ "application/json": { schema: { type: "object", properties: { n: { example: 5 } } } } }), SPEC)).toBe('{\n  "n": 5\n}');
		expect(getBodyPlaceholder(post({ "application/json": { schema: { $ref: "#/missing", type: "boolean" } } }), SPEC)).toBe("true");
		const user = JSON.parse(
			getBodyPlaceholder(post({ "application/json": { schema: { $ref: "#/components/schemas/User" } } }), SPEC),
		);
		expect(user).toMatchObject({ id: 0, name: "string", role: "admin", active: true, tags: ["string"] });
		// A schema that refers to itself stops after a few levels.
		expect(user.manager.manager.manager).toEqual({ id: null, name: null, role: null, active: null, tags: null, manager: null });
	});

	it("gives an empty object without a JSON body", () => {
		expect(getBodyPlaceholder({} as never, SPEC)).toBe("{}");
		expect(getBodyPlaceholder({ requestBody: {} } as never, SPEC)).toBe("{}");
		expect(getBodyPlaceholder(post({ "text/plain": {} }), SPEC)).toBe("{}");
		expect(getBodyPlaceholder(post({ "application/json": {} }), SPEC)).toBe("{}");
	});

	it("builds the odd shapes", () => {
		expect(buildExampleFromSchema({ properties: { a: { type: "number" } } }, SPEC, 0)).toEqual({ a: 0 });
		expect(buildExampleFromSchema({ type: "object" }, SPEC, 0)).toEqual({});
		expect(buildExampleFromSchema({ type: "array" }, SPEC, 0)).toEqual([]);
		expect(buildExampleFromSchema({ type: "string" }, SPEC, 0)).toBe("string");
		expect(buildExampleFromSchema({ $ref: "#/missing" }, SPEC, 0)).toBeNull();
		expect(buildExampleFromSchema({ type: "string" }, SPEC, 4)).toBeNull();
	});
});

describe("SchemaViewer", () => {
	it("shows the properties, what is required, and the nested schemas", () => {
		render(<SchemaViewer schema={{ $ref: "#/components/schemas/User" }} spec={SPEC} />);
		expect(screen.getAllByText("required")).not.toHaveLength(0);
		expect(screen.getAllByText("— The id")).not.toHaveLength(0);
		expect(screen.getAllByText("↗ ref")).not.toHaveLength(0);
		expect(screen.getAllByText("items:")).not.toHaveLength(0);
		// A schema that refers to itself stops after a few levels.
		expect(screen.getAllByText("...")).not.toHaveLength(0);
	});

	it("names a bare type, with its description, and 'any' without one", () => {
		const { rerender } = render(<SchemaViewer schema={{ type: "string", description: "A name" }} spec={SPEC} />);
		expect(screen.getByText("string — A name")).toBeInTheDocument();
		rerender(<SchemaViewer schema={{ properties: { a: {} } }} spec={SPEC} />);
		expect(screen.getByText("any")).toBeInTheDocument();
		rerender(<SchemaViewer schema={{ type: "object", properties: { a: {} } }} spec={SPEC} />);
		expect(screen.getByText("?")).toBeInTheDocument();
		rerender(<SchemaViewer schema={{ $ref: "#/missing", type: "integer" }} spec={SPEC} />);
		expect(screen.getByText("integer")).toBeInTheDocument();
		rerender(<SchemaViewer schema={{ type: "array", items: { type: "number" } }} spec={SPEC} />);
		expect(screen.getByText("number")).toBeInTheDocument();
	});
});

describe("CustomSelect", () => {
	it("shows a value it has no option for as it is", () => {
		render(<CustomSelect value="custom" onChange={vi.fn()} options={[]} />);
		expect(screen.getByRole("button", { name: "custom" })).toBeInTheDocument();
	});
});

describe("the shared helpers", () => {
	it("colours keys, strings, numbers and keywords of escaped JSON", () => {
		const html = syntaxHighlightJson('{"a<b":"x \\" 1 true","n":-1.5e3,"t":false,"z":null}');
		expect(html).toContain('<span style="color:var(--color-primary)">&quot;a&lt;b&quot;:</span>');
		// A number or a keyword inside a string stays in the string.
		expect(html).toContain('<span style="color:#98c379">&quot;x \\&quot; 1 true&quot;</span>');
		expect(html).toContain('<span style="color:#d19a66">-1500</span>');
		expect(html).toContain('<span style="color:#e5c07b">false</span>');
		expect(html).toContain('<span style="color:#abb2bf">null</span>');
		expect(syntaxHighlightJson("<b>not json")).toBe("&lt;b&gt;not json");
		expect(escapeHtml('a&"')).toBe("a&amp;&quot;");
	});

	it("resolves a local $ref, with escaped names, and nothing else", () => {
		expect(resolveRef("#/components/schemas/a~1b", SPEC)).toEqual({ type: "string", example: "slashed" });
		expect(resolveRef("#/components/schemas/Gone", SPEC)).toBeNull();
		expect(resolveRef("#/info/title", SPEC)).toBeNull();
		expect(resolveRef("#/info/title/x", SPEC)).toBeNull();
		expect(resolveRef("#/__proto__", SPEC)).toBeNull();
		expect(resolveRef("other.yaml#/User", SPEC)).toBeNull();
	});

	it("indents XML and colours statuses and methods", () => {
		expect(prettifyXml('<?xml version="1.0"?><a><b>1</b><c/><d>\n</d></a>')).toBe(
			'<?xml version="1.0"?>\n<a>\n  <b>1</b>\n  <c/>\n  <d>\n  </d>\n</a>',
		);
		expect(prettifyXml("<a>x\n\ny</a>")).toBe("<a>x\n  y</a>");
		expect(getStatusColor(201)).toBe("text-success");
		expect(getStatusColor(0)).toBe("text-gray-400");
		const { rerender } = render(<MethodBadge method="get" />);
		expect(screen.getByText("GET")).toHaveClass("text-blue-400", "px-1.5");
		rerender(<MethodBadge method="trace" size="md" />);
		expect(screen.getByText("TRACE")).toHaveClass("text-gray-400", "px-2.5");
	});
});
