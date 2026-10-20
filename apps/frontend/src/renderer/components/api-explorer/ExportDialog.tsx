/**
 * Exporting the explored API as a Postman collection or Markdown documentation.
 * Split out of ApiExplorer.tsx (audit lot L11, F36).
 */

import { Check, Copy, Download, X } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	type OpenApiOperation,
	type OpenApiSpec,
	useApiExplorerStore,
} from "../../stores/api-explorer-store";
import { MethodBadge } from "./api-explorer-shared";

// ── Export Dialog ────────────────────────────────────────────────────────────

export interface ExportDialogProps {
	readonly spec: OpenApiSpec;
	readonly onClose: () => void;
}

export function buildPostmanCollection(spec: OpenApiSpec, baseUrl: string) {
	const items: unknown[] = [];
	const tagMap: Record<string, unknown[]> = {};

	for (const [path, methods] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(methods)) {
			if (
				["get", "post", "put", "delete", "patch", "head", "options"].includes(
					method,
				)
			) {
				const tags = op.tags ?? ["default"];
				const request: Record<string, unknown> = {
					method: method.toUpperCase(),
					header: Object.entries(
						op.parameters
							?.filter((p) => p.in === "header")
							.reduce<Record<string, string>>((acc, p) => {
								acc[p.name] = p.example ? JSON.stringify(p.example) : "";
								return acc;
							}, {}) ?? {},
					).map(([key, value]) => ({ key, value })),
					url: {
						raw: `${baseUrl}${path}`,
						host: [baseUrl],
						path: path
							.split("/")
							.filter(Boolean)
							.map((s) => (s.startsWith("{") ? `:${s.slice(1, -1)}` : s)),
					},
				};
				if (op.requestBody) {
					const contentType =
						Object.keys(op.requestBody.content ?? {})[0] ?? "application/json";
					request.body = {
						mode: "raw",
						raw: JSON.stringify(
							op.requestBody.content?.[contentType]?.example ?? {},
							null,
							2,
						),
						options: { raw: { language: "json" } },
					};
				}
				const item = {
					name: op.summary ?? `${method.toUpperCase()} ${path}`,
					request,
				};
				for (const tag of tags) {
					if (!tagMap[tag]) tagMap[tag] = [];
					tagMap[tag].push(item);
				}
			}
		}
	}

	for (const [tag, tagItems] of Object.entries(tagMap)) {
		items.push({ name: tag, item: tagItems });
	}

	return {
		info: {
			name: spec.info.title,
			description: spec.info.description ?? "",
			schema:
				"https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		},
		item: items,
	};
}

export function buildMarkdownDocs(spec: OpenApiSpec): string {
	const lines: string[] = [`# ${spec.info.title}`, ""];

	if (spec.info.description) {
		lines.push(spec.info.description, "");
	}

	lines.push(`**Version:** ${spec.info.version}`, "");

	const tagMap: Record<
		string,
		Array<{ method: string; path: string; op: OpenApiOperation }>
	> = {};
	for (const [path, methods] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(methods)) {
			const tag = op.tags?.[0] ?? "default";
			if (!tagMap[tag]) tagMap[tag] = [];
			tagMap[tag].push({ method, path, op });
		}
	}

	for (const [tag, endpoints] of Object.entries(tagMap)) {
		lines.push(`## ${tag}`, "");

		for (const { method, path, op } of endpoints) {
			lines.push(`### \`${method.toUpperCase()} ${path}\``, "");

			if (op.summary) lines.push(`**${op.summary}**`);
			if (op.description) lines.push(op.description);
			lines.push("");

			if (op.parameters && op.parameters.length > 0) {
				lines.push(
					"**Parameters:**",
					"",
					"| Name | In | Type | Required | Description |",
					"|------|----|------|----------|-------------|",
					...op.parameters.map(
						(param) =>
							`| \`${param.name}\` | ${param.in} | ${param.schema?.type ?? "-"} | ${param.required ? "✓" : "-"} | ${param.description ?? "-"} |`,
					),
					"",
				);
			}
			if (op.responses) {
				lines.push(
					"**Responses:**",
					"",
					"| Status | Description |",
					"|--------|-------------|",
					...Object.entries(op.responses).map(
						([status, resp]) => `| ${status} | ${resp.description ?? "-"} |`,
					),
					"",
				);
			}
		}
	}
	return lines.join("\n");
}

export function ExportDialog({ spec, onClose }: ExportDialogProps) {
	const { t } = useTranslation(["apiExplorer"]);
	const environments = useApiExplorerStore((s) => s.environments);
	const activeEnvironmentId = useApiExplorerStore((s) => s.activeEnvironmentId);
	const activeEnv =
		environments.find((e) => e.id === activeEnvironmentId) ?? environments[0];
	const [copied, setCopied] = useState(false);

	const httpMethods = [
		"get",
		"post",
		"put",
		"delete",
		"patch",
		"head",
		"options",
	];

	const allEndpoints = useMemo(() => {
		const endpoints: Array<{ key: string; method: string; path: string }> = [];
		for (const [path, methods] of Object.entries(spec.paths ?? {})) {
			for (const method of Object.keys(methods)) {
				if (httpMethods.includes(method)) {
					endpoints.push({ key: `${method}::${path}`, method, path });
				}
			}
		}
		return endpoints;
	}, [spec, httpMethods.includes]);

	const [selectedEndpoints, setSelectedEndpoints] = useState<Set<string>>(
		() => new Set(allEndpoints.map((e) => e.key)),
	);

	const allSelected = selectedEndpoints.size === allEndpoints.length;

	function toggleEndpoint(key: string) {
		setSelectedEndpoints((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	function toggleAll() {
		if (allSelected) {
			setSelectedEndpoints(new Set());
		} else {
			setSelectedEndpoints(new Set(allEndpoints.map((e) => e.key)));
		}
	}

	function getFilteredSpec(): OpenApiSpec {
		if (selectedEndpoints.size === allEndpoints.length) return spec;
		const filteredPaths: Record<string, Record<string, OpenApiOperation>> = {};
		for (const [path, methods] of Object.entries(spec.paths ?? {})) {
			const filteredMethods: Record<string, OpenApiOperation> = {};
			for (const [method, op] of Object.entries(methods)) {
				if (selectedEndpoints.has(`${method}::${path}`)) {
					filteredMethods[method] = op;
				}
			}
			if (Object.keys(filteredMethods).length > 0) {
				filteredPaths[path] = filteredMethods;
			}
		}
		return { ...spec, paths: filteredPaths };
	}

	function download(content: string, filename: string, mime: string) {
		const blob = new Blob([content], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function exportOpenApi() {
		download(
			JSON.stringify(getFilteredSpec(), null, 2),
			"openapi.json",
			"application/json",
		);
	}

	function exportPostman() {
		const collection = buildPostmanCollection(
			getFilteredSpec(),
			activeEnv?.baseUrl ?? "",
		);
		download(
			JSON.stringify(collection, null, 2),
			"collection.postman_collection.json",
			"application/json",
		);
	}

	function exportMarkdown() {
		const filtered = getFilteredSpec();
		download(
			buildMarkdownDocs(filtered),
			`${filtered.info.title.toLowerCase().replaceAll(/\s+/g, "-")}-api.md`,
			"text/markdown",
		);
	}

	function copyOpenApi() {
		navigator.clipboard.writeText(JSON.stringify(getFilteredSpec(), null, 2));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	const formats = [
		{
			label: "OpenAPI 3.x JSON",
			description: t("apiExplorer:export.openapiDesc"),
			icon: "{}",
			action: exportOpenApi,
		},
		{
			label: "Postman Collection v2.1",
			description: t("apiExplorer:export.postmanDesc"),
			icon: "📮",
			action: exportPostman,
		},
		{
			label: "Markdown Documentation",
			description: t("apiExplorer:export.markdownDesc"),
			icon: "MD",
			action: exportMarkdown,
		},
	];

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-md p-6">
				<div className="flex items-center justify-between mb-5">
					<h2 className="text-base font-semibold text-[var(--color-text-primary)]">
						{t("apiExplorer:export.title")}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
					>
						<X size={18} />
					</button>
				</div>

				{allEndpoints.length > 0 && (
					<div className="mb-4">
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs font-medium text-[var(--color-text-secondary)]">
								{t("apiExplorer:export.endpoints", {
									selected: selectedEndpoints.size,
									total: allEndpoints.length,
								})}
							</span>
							<button
								type="button"
								onClick={toggleAll}
								className="text-xs text-[var(--color-primary)] hover:underline"
							>
								{allSelected
									? t("apiExplorer:export.deselectAll")
									: t("apiExplorer:export.selectAll")}
							</button>
						</div>
						<div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
							{allEndpoints.map((ep) => (
								<label
									key={ep.key}
									className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-[var(--color-bg-secondary)] select-none"
								>
									<input
										type="checkbox"
										checked={selectedEndpoints.has(ep.key)}
										onChange={() => toggleEndpoint(ep.key)}
										className="shrink-0 accent-[var(--color-primary)]"
									/>
									<MethodBadge method={ep.method} />
									<span className="text-xs text-[var(--color-text-secondary)] truncate font-mono">
										{ep.path}
									</span>
								</label>
							))}
						</div>
					</div>
				)}

				<div className="space-y-2.5">
					{formats.map((fmt) => (
						<button
							type="button"
							key={fmt.label}
							onClick={fmt.action}
							disabled={selectedEndpoints.size === 0}
							className="w-full text-left flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-bg-secondary)] transition-all group disabled:opacity-40 disabled:cursor-not-allowed"
						>
							<div className="w-10 h-10 rounded-lg bg-[var(--color-bg-tertiary)] flex items-center justify-center text-xs font-bold font-mono text-[var(--color-text-secondary)] shrink-0">
								{fmt.icon}
							</div>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium text-[var(--color-text-primary)]">
									{fmt.label}
								</div>
								<div className="text-xs text-[var(--color-text-muted)] mt-0.5">
									{fmt.description}
								</div>
							</div>
							<Download
								size={15}
								className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)] transition-colors shrink-0"
							/>
						</button>
					))}
				</div>

				<div className="mt-4 pt-4 border-t border-[var(--color-border)]">
					<button
						type="button"
						onClick={copyOpenApi}
						disabled={selectedEndpoints.size === 0}
						className="w-full flex items-center justify-center gap-2 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{copied ? (
							<Check size={14} className="text-emerald-400" />
						) : (
							<Copy size={14} />
						)}
						{copied
							? t("apiExplorer:export.copied")
							: t("apiExplorer:export.copySpec")}
					</button>
				</div>
			</div>
		</div>,
		document.getElementById("root") ?? document.body,
	);
}
