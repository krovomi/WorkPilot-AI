/**
 * Helpers and small pieces every API Explorer panel shares: status and method
 * colours, JSON/XML pretty-printing and highlighting, $ref resolution, the method
 * badge. Split out of ApiExplorer.tsx (audit lot L11, F36).
 */

import { type OpenApiSpec } from "../../stores/api-explorer-store";

// ── Utilities ────────────────────────────────────────────────────────────────

export const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "text-blue-400 bg-blue-400/10 border-blue-400/30",
	POST: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
	PUT: "text-amber-400 bg-amber-400/10 border-amber-400/30",
	DELETE: "text-red-400 bg-red-400/10 border-red-400/30",
	PATCH: "text-orange-400 bg-orange-400/10 border-orange-400/30",
	HEAD: "text-purple-400 bg-purple-400/10 border-purple-400/30",
	OPTIONS: "text-gray-400 bg-gray-400/10 border-gray-400/30",
};

export const STATUS_COLORS: Record<string, string> = {
	"2": "text-emerald-400",
	"3": "text-blue-400",
	"4": "text-amber-400",
	"5": "text-red-400",
};

export function getStatusColor(status: number): string {
	return STATUS_COLORS[String(status)[0]] ?? "text-gray-400";
}

export function _prettyJson(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

export function prettifyXml(value: string): string {
	let formatted = "";
	let indent = 0;
	const lines = value.replaceAll(/>\s*</g, ">\n<").split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
		formatted += `${"  ".repeat(indent) + trimmed}\n`;
		if (
			!trimmed.endsWith("/>") &&
			!trimmed.startsWith("</") &&
			/^<[^?!]/.test(trimmed) &&
			!/<.*>.*<\/.*>/.test(trimmed)
		) {
			indent++;
		}
	}
	return formatted.trimEnd();
}

// HTML-escape a string for safe insertion into innerHTML
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

// Returns an HTML string with syntax-highlighted JSON
export function syntaxHighlightJson(value: string): string {
	let pretty: string;
	try {
		pretty = JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return escapeHtml(value);
	}
	return escapeHtml(pretty).replaceAll(
		/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
		(match) => {
			if (match.startsWith('"')) {
				if (match.endsWith(":")) {
					return `<span style="color:var(--color-primary)">${match}</span>`;
				}
				return `<span style="color:#98c379">${match}</span>`;
			}
			if (/true|false/.test(match))
				return `<span style="color:#e5c07b">${match}</span>`;
			if (/null/.test(match))
				return `<span style="color:#abb2bf">${match}</span>`;
			return `<span style="color:#d19a66">${match}</span>`;
		},
	);
}

export function detectContentType(headers: Record<string, string>): string {
	const ct = headers["content-type"] ?? headers["Content-Type"] ?? "";
	return ct.toLowerCase();
}

export function resolveRef(
	ref: string,
	spec: OpenApiSpec,
): Record<string, unknown> | null {
	if (!ref.startsWith("#/")) return null;
	const parts = ref.slice(2).split("/");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	let current: any = spec;
	for (const part of parts) {
		if (!current || typeof current !== "object") return null;
		current = current[part];
	}
	return current ?? null;
}

// ── Sub-components ───────────────────────────────────────────────────────────

export interface MethodBadgeProps {
	readonly method: string;
	readonly size?: "sm" | "md";
}

export function MethodBadge({ method, size = "sm" }: MethodBadgeProps) {
	const colors =
		HTTP_METHOD_COLORS[method.toUpperCase()] ??
		"text-gray-400 bg-gray-400/10 border-gray-400/30";
	const padding =
		size === "md" ? "px-2.5 py-1 text-xs" : "px-1.5 py-0.5 text-[10px]";
	return (
		<span
			className={`inline-block font-mono font-bold rounded border ${padding} ${colors}`}
		>
			{method.toUpperCase()}
		</span>
	);
}
