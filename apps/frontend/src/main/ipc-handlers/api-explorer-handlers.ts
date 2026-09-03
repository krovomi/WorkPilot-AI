import path from "node:path";
import { app, ipcMain, net, safeStorage } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import { detectDotnet } from "../api-explorer/dotnet";
import { detectGo } from "../api-explorer/go";
import { detectSpring } from "../api-explorer/jvm";
import { detectNode } from "../api-explorer/node";
import { detectPython } from "../api-explorer/python";
import {
	buildProbeUrls,
	discoverBaseUrls,
	type LiveSpec,
	probeLiveSpec,
} from "../api-explorer/live-spec";
import { findCommittedSpec } from "../api-explorer/spec-files";
import {
	readDirectory,
	readFile,
	walkFiles,
} from "../api-explorer/source-files";
import type {
	DetectedRoute,
	JsonSchema,
	RouteParameter,
} from "../api-explorer/types";
import {
	ApiExplorerSecretStore,
	type ApiExplorerSecretValues,
} from "../api-explorer-secret-store";

// ── Language detectors ────────────────────────────────────────────────────────
// ASP.NET Core lives in ../api-explorer/dotnet.ts: it reads action signatures
// and DTOs, so it needs more than a regex sweep. The detectors below stay
// declaration-level on purpose.

/** Rust — Axum / Actix */
function detectRust(projectPath: string): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	const files = walkFiles(projectPath, [".rs"]);

	for (const filePath of files) {
		const content = readFile(filePath);
		if (!content) continue;
		const tag = path.basename(filePath, ".rs");

		const axumRe =
			/\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|delete|patch)/g;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((m = axumRe.exec(content)) !== null) {
			routes.push({
				path: m[1],
				methods: [m[2].toUpperCase()],
				tag,
				file: path.relative(projectPath, filePath),
				framework: "Rust/Axum",
				requiresAuth: false,
			});
		}
	}
	return routes;
}

/** Rails — Ruby config/routes.rb */
function detectRails(projectPath: string): DetectedRoute[] {
	const routes: DetectedRoute[] = [];
	const files = walkFiles(projectPath, [".rb"]).filter((f) =>
		f.endsWith("routes.rb"),
	);

	for (const filePath of files) {
		const content = readFile(filePath);
		if (!content) continue;

		const verbRe = /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((m = verbRe.exec(content)) !== null) {
			const p = m[2].startsWith("/") ? m[2] : `/${m[2]}`;
			routes.push({
				path: p,
				methods: [m[1].toUpperCase()],
				tag: "routes",
				file: path.relative(projectPath, filePath),
				framework: "Rails",
				requiresAuth: false,
			});
		}

		const resourcesRe = /resources\s+:(\w+)/g;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((m = resourcesRe.exec(content)) !== null) {
			const base = `/${m[1]}`;
			for (const [p, method] of [
				[base, "GET"],
				[base, "POST"],
				[`${base}/{id}`, "GET"],
				[`${base}/{id}`, "PUT"],
				[`${base}/{id}`, "DELETE"],
			] as [string, string][]) {
				routes.push({
					path: p,
					methods: [method],
					tag: m[1],
					file: path.relative(projectPath, filePath),
					framework: "Rails",
					requiresAuth: false,
				});
			}
		}
	}
	return routes;
}

// ── OpenAPI spec builder ──────────────────────────────────────────────────────

function buildOpenApiSpec(
	routes: DetectedRoute[],
	projectName: string,
	schemas: Record<string, JsonSchema> = {},
): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	const tags = new Set<string>();

	for (const route of routes) {
		// Convert {param} style (ASP.NET / Java) and [param] style to OpenAPI {param}
		const openApiPath = route.path
			.replace(/\[([^\]]+)\]/g, "{$1}")
			.replace(/\/+/g, "/");

		if (!paths[openApiPath]) paths[openApiPath] = {};

		for (const method of route.methods) {
			const op: Record<string, unknown> = {
				tags: [route.tag],
				summary: route.summary ?? `${method} ${openApiPath}`,
				operationId: `${method.toLowerCase()}_${openApiPath
					.replace(/[^a-zA-Z0-9]/g, "_")
					.replace(/_+/g, "_")
					.replace(/^_|_$/g, "")}`,
				responses: buildResponses(route),
			};

			if (route.description) op.description = route.description;
			if (route.deprecated) op.deprecated = true;

			if (route.requiresAuth) {
				op.security = [{ bearerAuth: [] }];
			}

			const parameters = buildParameters(route, openApiPath);
			if (parameters.length > 0) op.parameters = parameters;

			if (route.requestBody) {
				op.requestBody = {
					required: route.requestBody.required,
					content: {
						[route.requestBody.contentType]: {
							schema: route.requestBody.schema,
						},
					},
				};
			}

			paths[openApiPath][method.toLowerCase()] = op;
			tags.add(route.tag);
		}
	}

	const components: Record<string, unknown> = {
		securitySchemes: {
			bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
		},
	};
	if (Object.keys(schemas).length > 0) components.schemas = schemas;

	return {
		openapi: "3.0.0",
		info: {
			title: projectName,
			version: "0.0.0",
			description: `API endpoints scanned from project source code (${routes.length} endpoints detected).`,
		},
		tags: [...tags].map((name) => ({ name })),
		paths,
		components,
	};
}

/**
 * Parameters as the detector read them, completed with any path placeholder it
 * did not describe — a detector that only knows the template still yields a
 * form with one field per `{param}`.
 */
function buildParameters(
	route: DetectedRoute,
	openApiPath: string,
): RouteParameter[] {
	const parameters = [...(route.parameters ?? [])];
	const known = new Set(
		parameters
			.filter((parameter) => parameter.in === "path")
			.map((parameter) => parameter.name),
	);

	for (const match of openApiPath.matchAll(/\{([^}]+)\}/g)) {
		if (known.has(match[1])) continue;
		parameters.push({
			name: match[1],
			in: "path",
			required: true,
			schema: { type: "string" },
		});
	}

	return parameters;
}

function buildResponses(route: DetectedRoute): Record<string, unknown> {
	if (!route.responses || Object.keys(route.responses).length === 0) {
		return { "200": { description: "Success" } };
	}

	const responses: Record<string, unknown> = {};
	for (const [status, response] of Object.entries(route.responses)) {
		responses[status] = response.schema
			? {
					description: response.description,
					content: { "application/json": { schema: response.schema } },
				}
			: { description: response.description };
	}
	return responses;
}


/**
 * One probe request: abandoned at `timeoutMs`, and yielding a body only for a
 * successful response small enough to be a description rather than a dump.
 */
const fetchSpecBody = async (
	url: string,
	timeoutMs: number,
): Promise<string | null> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await net.fetch(url, {
			method: "GET",
			headers: { Accept: "application/json, application/yaml, text/plain" },
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const declaredLength = Number.parseInt(
			res.headers.get("content-length") ?? "",
			10,
		);
		if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024 * 1024) {
			return null;
		}
		return await res.text();
	} catch {
		// A refused connection, a timeout, a TLS the dev certificate cannot
		// satisfy: none of them are errors here, they are simply not a match.
		return null;
	} finally {
		clearTimeout(timer);
	}
};

// ── IPC handler registration ──────────────────────────────────────────────────

interface ProxyRequestPayload {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

interface ProxyResponse {
	success: boolean;
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	time?: number;
	error?: string;
}

export function registerApiExplorerHandlers(): void {
	const secretStore = new ApiExplorerSecretStore(
		path.join(app.getPath("userData"), "api-explorer-secrets.json"),
		safeStorage,
	);
	ipcMain.handle(
		IPC_CHANNELS.API_EXPLORER_LOAD_SECRETS,
		(_event, scope: string) => {
			try {
				return { success: true, data: secretStore.load(scope) };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);
	ipcMain.handle(
		IPC_CHANNELS.API_EXPLORER_SAVE_SECRETS,
		(_event, scope: string, values: ApiExplorerSecretValues) => {
			try {
				secretStore.save(scope, values);
				return { success: true };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);
	ipcMain.handle(
		IPC_CHANNELS.API_EXPLORER_SCAN_ROUTES,
		(_event, projectPath: string, projectName: string) => {
			try {
				// An unreadable root walks to an empty list exactly like a project
				// with no sources, and "0 endpoints" would then mean two different
				// things. Say which one it is.
				if (readDirectory(projectPath) === null) {
					return {
						success: false,
						error: `Cannot read project directory: ${projectPath}`,
					};
				}

				const dotnet = detectDotnet(projectPath);
				const routes: DetectedRoute[] = [
					...dotnet.routes,
					...detectPython(projectPath),
					...detectNode(projectPath),
					...detectSpring(projectPath),
					...detectGo(projectPath),
					...detectRust(projectPath),
					...detectRails(projectPath),
				];

				const scanned = buildOpenApiSpec(
					routes,
					projectName || "Project",
					dotnet.schemas,
				);
				const frameworks = [...new Set(routes.map((route) => route.framework))];

				// A description the team wrote and versions beats anything inferred
				// from source: it states the paths, parameters and schemas outright.
				const committed = findCommittedSpec(projectPath);

				return {
					success: true,
					data: committed?.document ?? scanned,
					source: committed ? "file" : "scan",
					specFile: committed?.relativePath,
					routeCount: committed ? committed.pathCount : routes.length,
					filesScanned: dotnet.filesScanned,
					frameworks,
					specUrls: buildProbeUrls(
						discoverBaseUrls(projectPath, frameworks),
						frameworks,
					),
				};
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	// Live document — asks the running application for its own description.
	// Bounded on every axis (candidates, per-request timeout, total budget) so
	// a fallback can never become a wait; see PROBE_LIMITS.
	ipcMain.handle(
		IPC_CHANNELS.API_EXPLORER_PROBE_LIVE_SPEC,
		async (
			_event,
			projectPath: string,
			frameworks: string[],
		): Promise<{
			success: boolean;
			data?: Record<string, unknown> | null;
			url?: string;
			routeCount?: number;
			error?: string;
		}> => {
			try {
				const urls = buildProbeUrls(
					discoverBaseUrls(projectPath, frameworks ?? []),
					frameworks ?? [],
				);
				const found: LiveSpec | null = await probeLiveSpec(
					urls,
					fetchSpecBody,
				);
				return found
					? {
							success: true,
							data: found.document,
							url: found.url,
							routeCount: found.pathCount,
						}
					: { success: true, data: null };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	// HTTP proxy — makes requests from main process to bypass renderer CSP
	ipcMain.handle(
		IPC_CHANNELS.API_EXPLORER_PROXY_REQUEST,
		async (_event, payload: ProxyRequestPayload): Promise<ProxyResponse> => {
			const start = Date.now();
			try {
				const res = await net.fetch(payload.url, {
					method: payload.method,
					headers: payload.headers,
					body: payload.body ?? undefined,
				});

				const resHeaders: Record<string, string> = {};
				res.headers.forEach((val: string, key: string) => {
					resHeaders[key] = val;
				});

				const contentType = res.headers.get("content-type") ?? "";
				let body: string;
				if (
					contentType.includes("application/json") ||
					contentType.includes("text/")
				) {
					body = await res.text();
				} else {
					body = `[Binary content: ${contentType}]`;
				}

				return {
					success: true,
					status: res.status,
					statusText: res.statusText,
					headers: resHeaders,
					body,
					time: Date.now() - start,
				};
			} catch (err) {
				return {
					success: false,
					status: 0,
					statusText: "Network Error",
					headers: {},
					body: String(err),
					time: Date.now() - start,
					error: String(err),
				};
			}
		},
	);
}
