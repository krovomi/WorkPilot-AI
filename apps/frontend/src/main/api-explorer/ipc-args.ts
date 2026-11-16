/**
 * The arguments the API Explorer's handlers take from the renderer, checked
 * in the main before they are used: the request it sends on the user's
 * behalf, and the scope and values of the secrets it keeps.
 */
import { z } from "zod";
import type { ApiExplorerSecretValues } from "../api-explorer-secret-store";

const METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
] as const;

const MAX_URL = 8 * 1024;
const MAX_HEADERS = 100;
const MAX_HEADER_VALUE = 16 * 1024;
const MAX_BODY = 10 * 1024 * 1024;
const MAX_SECRET = 64 * 1024;
/** `request:<project>:<METHOD>:<path>` or `environment:<project>:<env>`. */
const SCOPE = /^(request|environment):./;
const MAX_SCOPE = 4096;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;

/** A web address of the API under test: http or https, nothing else. */
const httpUrl = z
	.string()
	.max(MAX_URL)
	.refine((value) => {
		try {
			const { protocol } = new URL(value);
			return protocol === "http:" || protocol === "https:";
		} catch {
			return false;
		}
	}, "Only http and https addresses can be requested");

const proxyRequest = z.strictObject({
	url: httpUrl,
	method: z
		.string()
		.transform((method) => method.toUpperCase())
		.pipe(z.enum(METHODS)),
	headers: z
		.record(z.string().regex(HEADER_NAME), z.string().max(MAX_HEADER_VALUE))
		.refine((headers) => Object.keys(headers).length <= MAX_HEADERS),
	body: z.string().max(MAX_BODY).optional(),
});

export type ProxyRequestPayload = z.infer<typeof proxyRequest>;

const secret = z.string().max(MAX_SECRET).optional();
const secretValues = z.strictObject({
	bearer: secret,
	password: secret,
	keyValue: secret,
	oauth2ClientSecret: secret,
	oauth2AccessToken: secret,
	environmentToken: secret,
});

/** A path from a spec may hold a space; a control character is refused. */
const hasControlCharacter = (value: string) =>
	[...value].some((char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 || code === 0x7f;
	});

const scope = z
	.string()
	.max(MAX_SCOPE)
	.regex(SCOPE)
	.refine((value) => !hasControlCharacter(value));

/** The request to send, or why it is refused. */
export function readProxyRequest(payload: unknown): ProxyRequestPayload {
	return proxyRequest.parse(payload);
}

export function readSecretScope(value: unknown): string {
	return scope.parse(value);
}

export function readSecretValues(value: unknown): ApiExplorerSecretValues {
	return secretValues.parse(value);
}
