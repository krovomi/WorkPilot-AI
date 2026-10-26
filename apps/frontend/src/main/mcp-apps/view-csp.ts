/**
 * The Content-Security-Policy an MCP App view is served with.
 *
 * MCP Apps (2026-01-26): without a declaration, a view reaches nothing
 * outside itself; with `_meta.ui.csp`, it reaches exactly the origins it
 * declares, and the host must not allow any it did not. A declared origin is
 * kept only when it is a bare `https://` origin (`wss://` too for
 * `connectDomains`), with at most a leading `*.` on the host: anything else
 * (a scheme like `data:` or `http:`, a path, a quote, a keyword such as
 * `'unsafe-eval'`) is dropped, never passed through.
 */

import type { ViewUi } from "./view-store";

const HTTPS_ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
const WSS_ORIGIN = /^wss:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
const MAX_ORIGINS = 32;

function origins(raw: unknown, allowWss = false): string[] {
	if (!Array.isArray(raw)) return [];
	const kept: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const value = entry.trim().replace(/\/$/, "");
		if (HTTPS_ORIGIN.test(value) || (allowWss && WSS_ORIGIN.test(value))) {
			if (!kept.includes(value)) kept.push(value);
		}
		if (kept.length >= MAX_ORIGINS) break;
	}
	return kept;
}

function sources(base: string[], extra: string[], none = "'none'"): string {
	const all = [...base, ...extra];
	return all.length ? all.join(" ") : none;
}

/** The policy for one view, from its resource's `_meta.ui`. */
export function buildViewCsp(ui: ViewUi | undefined): string {
	const csp = ui?.csp ?? {};
	const resources = origins(csp.resourceDomains);
	const connect = origins(csp.connectDomains, true);
	const frames = origins(csp.frameDomains);
	const baseUris = origins(csp.baseUriDomains);
	return [
		"default-src 'none'",
		`script-src ${sources(["'self'", "'unsafe-inline'"], resources)}`,
		`style-src ${sources(["'self'", "'unsafe-inline'"], resources)}`,
		`img-src ${sources(["'self'", "data:"], resources)}`,
		`font-src ${sources(["'self'", "data:"], resources)}`,
		`media-src ${sources(["'self'", "data:"], resources)}`,
		`connect-src ${sources([], connect)}`,
		`frame-src ${sources([], frames)}`,
		"object-src 'none'",
		`base-uri ${sources(["'self'"], baseUris)}`,
		"form-action 'none'",
	].join("; ");
}

/**
 * The same policy as a `<meta>` at the top of the document, in case the
 * header is not applied: a second policy can only restrict further.
 */
export function withCspMeta(html: string, csp: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
	if (doctype) {
		return `${doctype[0]}${meta}${html.slice(doctype[0].length)}`;
	}
	return `${meta}${html}`;
}
