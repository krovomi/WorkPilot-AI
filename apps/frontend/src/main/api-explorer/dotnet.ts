import path from "node:path";
import {
	attributeArguments,
	attributeGenericArgument,
	attributeName,
	collectAnnotations,
	findMatching,
	findStatementEnd,
	parseXmlDoc,
	splitTopLevel,
	stringLiterals,
	unquote,
} from "./csharp-syntax";
import {
	type TypeDeclaration,
	indexTypeDeclarations,
	isSimpleType,
	parseParameterDeclaration,
	parseTypeName,
	SchemaFactory,
} from "./csharp-types";
import { readFile, walkFiles } from "./source-files";
import type {
	DetectedRoute,
	JsonSchema,
	RouteParameter,
	RouteRequestBody,
	RouteResponse,
	ScanResult,
} from "./types";

const FRAMEWORK = "ASP.NET Core";

const HTTP_VERBS = [
	"Get",
	"Post",
	"Put",
	"Delete",
	"Patch",
	"Head",
	"Options",
] as const;

const BODY_VERBS = new Set(["POST", "PUT", "PATCH"]);

/** Parameters bound by the framework, never by the caller. */
const AMBIENT_PARAMETER_TYPES = new Set([
	"cancellationtoken",
	"httpcontext",
	"httprequest",
	"httpresponse",
	"claimsprincipal",
	"iserviceprovider",
	"iconfiguration",
	"iwebhostenvironment",
	"ihostenvironment",
	"linkgenerator",
	"iurlhelper",
]);

const SERVICE_NAME_SUFFIXES = [
	"Service",
	"Repository",
	"Store",
	"Context",
	"Factory",
	"Provider",
	"Publisher",
	"Sender",
	"Accessor",
	"Mediator",
	"Logger",
	"Client",
];

const STATUS_DESCRIPTIONS: Record<string, string> = {
	"200": "Success",
	"201": "Created",
	"202": "Accepted",
	"204": "No Content",
	"400": "Bad Request",
	"401": "Unauthorized",
	"403": "Forbidden",
	"404": "Not Found",
	"405": "Method Not Allowed",
	"409": "Conflict",
	"415": "Unsupported Media Type",
	"422": "Unprocessable Entity",
	"429": "Too Many Requests",
	"500": "Internal Server Error",
	"503": "Service Unavailable",
};

/** Route constraints that say something about the parameter's type. */
const CONSTRAINT_SCHEMAS: Record<string, JsonSchema> = {
	int: { type: "integer", format: "int32" },
	long: { type: "integer", format: "int64" },
	bool: { type: "boolean" },
	decimal: { type: "number", format: "double" },
	double: { type: "number", format: "double" },
	float: { type: "number", format: "float" },
	guid: { type: "string", format: "uuid" },
	datetime: { type: "string", format: "date-time" },
	alpha: { type: "string" },
	length: { type: "string" },
	minlength: { type: "string" },
	maxlength: { type: "string" },
	regex: { type: "string" },
	min: { type: "integer", format: "int32" },
	max: { type: "integer", format: "int32" },
	range: { type: "integer", format: "int32" },
};

interface RouteTemplateParameter {
	name: string;
	schema: JsonSchema;
	required: boolean;
}

interface NormalizedRoute {
	path: string;
	parameters: RouteTemplateParameter[];
}

/**
 * Turns an ASP.NET route template into an OpenAPI path, dropping inline
 * constraints (`{id:int}`), default values (`{page=1}`) and catch-all markers
 * (`{*rest}`) while keeping what they say about the parameter.
 */
export function normalizeRouteTemplate(template: string): NormalizedRoute {
	const parameters: RouteTemplateParameter[] = [];
	const path = template.replace(/\{([^{}]+)\}/g, (_whole, token: string) => {
		let inner = token.trim();
		let required = true;

		if (inner.startsWith("**")) inner = inner.slice(2);
		else if (inner.startsWith("*")) inner = inner.slice(1);

		const equals = inner.indexOf("=");
		if (equals !== -1) {
			inner = inner.slice(0, equals);
			required = false;
		}
		if (inner.endsWith("?")) {
			inner = inner.slice(0, -1);
			required = false;
		}

		const segments = splitConstraints(inner);
		const name = segments[0]?.trim() ?? inner.trim();
		let schema: JsonSchema = { type: "string" };
		for (const constraint of segments.slice(1)) {
			const constraintName = constraint.split("(")[0].trim().toLowerCase();
			const known = CONSTRAINT_SCHEMAS[constraintName];
			if (known) schema = known;
		}

		if (name) parameters.push({ name, schema, required });
		return `{${name}}`;
	});

	return { path: collapseSlashes(path), parameters };
}

/** Splits `id:regex(a:b):min(1)` on the colons that separate constraints. */
function splitConstraints(token: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === ":" && depth === 0) {
			parts.push(token.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(token.slice(start));
	return parts;
}

function collapseSlashes(value: string): string {
	const collapsed = `/${value}`.replace(/\/+/g, "/");
	return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/**
 * Joins a minimal API group prefix to an endpoint template. A leading slash
 * there is decoration, not an escape hatch: `MapGroup("/api")` still prefixes
 * `MapGet("/items")`.
 */
function joinTemplates(prefix: string, template: string): string {
	return `${prefix}/${template.trim()}`;
}

function combineTemplates(base: string, template: string): string {
	const trimmed = template.trim();
	if (trimmed.startsWith("~/")) return trimmed.slice(1);
	if (trimmed.startsWith("/")) return trimmed;
	if (!trimmed) return base || "/";
	return `${base}/${trimmed}`;
}

// ── Attribute helpers ─────────────────────────────────────────────────────────

function findAttributes(attributes: string[], name: string): string[] {
	return attributes.filter((attribute) => attributeName(attribute) === name);
}

function hasAttribute(attributes: string[], name: string): boolean {
	return findAttributes(attributes, name).length > 0;
}

/** The route template of an `[HttpGet("…")]` or `[Route("…")]` attribute. */
function attributeTemplate(attribute: string): string | null {
	const args = splitTopLevel(attributeArguments(attribute));
	const first = args[0];
	if (!first?.trim().startsWith("\"")) return null;
	return unquote(first);
}

function ignoresApi(attributes: string[]): boolean {
	if (hasAttribute(attributes, "NonAction")) return true;
	return findAttributes(attributes, "ApiExplorerSettings").some((attribute) =>
		/IgnoreApi\s*=\s*true/i.test(attributeArguments(attribute)),
	);
}

// ── Parameter binding ─────────────────────────────────────────────────────────

interface BoundParameters {
	parameters: RouteParameter[];
	requestBody?: RouteRequestBody;
}

interface BindingContext {
	verb: string;
	routeParameterNames: Set<string>;
	docParams: Record<string, string>;
	types: Map<string, TypeDeclaration>;
	factory: SchemaFactory;
}

function isAmbient(type: string): boolean {
	const parsed = parseTypeName(type);
	const lower = parsed.name.toLowerCase();
	if (AMBIENT_PARAMETER_TYPES.has(lower)) return true;
	if (lower === "ilogger" || lower === "imediator" || lower === "imapper") {
		return true;
	}
	return false;
}

/** True for a type that looks injected rather than sent by the caller. */
function looksLikeService(
	type: string,
	types: Map<string, TypeDeclaration>,
): boolean {
	const parsed = parseTypeName(type);
	if (types.get(parsed.name)?.kind === "interface") return true;
	if (/^I[A-Z]/.test(parsed.name) && !types.has(parsed.name)) return true;
	return SERVICE_NAME_SUFFIXES.some((suffix) => parsed.name.endsWith(suffix));
}

function bindParameters(
	declarations: string[],
	context: BindingContext,
): BoundParameters {
	const parameters: RouteParameter[] = [];
	let requestBody: RouteRequestBody | undefined;

	for (const declaration of declarations) {
		const parsed = parseParameterDeclaration(declaration);
		if (!parsed) continue;
		if (hasAttribute(parsed.attributes, "FromServices")) continue;
		if (isAmbient(parsed.type)) continue;

		const explicitBody =
			hasAttribute(parsed.attributes, "FromBody") ||
			hasAttribute(parsed.attributes, "FromForm");
		const description = context.docParams[parsed.name];
		const schema = context.factory.fromType(parsed.type);

		if (explicitBody) {
			requestBody = {
				required: !parsed.hasDefault && !parsed.type.trim().endsWith("?"),
				contentType: hasAttribute(parsed.attributes, "FromForm")
					? "multipart/form-data"
					: "application/json",
				schema,
			};
			continue;
		}

		const headerAttribute = findAttributes(parsed.attributes, "FromHeader")[0];
		if (headerAttribute) {
			const named = attributeArguments(headerAttribute).match(
				/Name\s*=\s*("(?:[^"]*)")/,
			);
			parameters.push({
				name: named ? unquote(named[1]) : parsed.name,
				in: "header",
				required: !parsed.hasDefault && !parsed.type.trim().endsWith("?"),
				schema,
				description,
			});
			continue;
		}

		const inRoute =
			hasAttribute(parsed.attributes, "FromRoute") ||
			context.routeParameterNames.has(parsed.name.toLowerCase());
		if (inRoute) {
			parameters.push({
				name: parsed.name,
				in: "path",
				required: true,
				schema,
				description,
			});
			continue;
		}

		const simple = isSimpleType(parsed.type, context.types);
		if (hasAttribute(parsed.attributes, "FromQuery") || simple) {
			parameters.push({
				name: parsed.name,
				in: "query",
				required:
					!parsed.hasDefault &&
					!parsed.type.trim().endsWith("?") &&
					!parsed.type.trim().startsWith("Nullable"),
				schema,
				description,
			});
			continue;
		}

		if (looksLikeService(parsed.type, context.types)) continue;

		if (BODY_VERBS.has(context.verb)) {
			requestBody = {
				required: !parsed.type.trim().endsWith("?"),
				contentType: "application/json",
				schema,
			};
			continue;
		}

		// A complex type on a verb without a body binds from the query string,
		// one property at a time (`[AsParameters]` and MVC model binding alike).
		for (const query of flattenToQueryParameters(parsed.type, context)) {
			parameters.push(query);
		}
	}

	return { parameters, requestBody };
}

/** Expands a DTO bound from the query string into one parameter per property. */
function flattenToQueryParameters(
	type: string,
	context: BindingContext,
): RouteParameter[] {
	const parsed = parseTypeName(type);
	const declaration = context.types.get(parsed.name);
	if (!declaration || declaration.kind === "interface") return [];

	const schema = context.factory.fromType(type);
	const resolved = schema.$ref
		? context.factory.schemas[schema.$ref.split("/").pop() ?? ""]
		: schema;
	if (!resolved?.properties) return [];

	const required = new Set(resolved.required ?? []);
	return Object.entries(resolved.properties).map(([name, propertySchema]) => ({
		name,
		in: "query" as const,
		required: required.has(name),
		schema: propertySchema,
		description: propertySchema.description,
	}));
}

// ── Responses ─────────────────────────────────────────────────────────────────

function describeStatus(code: string): string {
	return STATUS_DESCRIPTIONS[code] ?? "Response";
}

function buildResponses(
	attributes: string[],
	returnType: string | undefined,
	factory: SchemaFactory,
): Record<string, RouteResponse> | undefined {
	const responses: Record<string, RouteResponse> = {};

	for (const attribute of findAttributes(attributes, "ProducesResponseType")) {
		const args = splitTopLevel(attributeArguments(attribute));
		let status: string | undefined;
		let payload = attributeGenericArgument(attribute);

		for (const arg of args) {
			const typeofMatch = arg.match(/typeof\s*\(([^)]*)\)/);
			if (typeofMatch) {
				payload = typeofMatch[1].trim();
				continue;
			}
			const statusMatch =
				arg.match(/Status(\d{3})/) ?? arg.match(/^\s*(\d{3})\s*$/);
			if (statusMatch) status = statusMatch[1];
		}
		if (!status) status = payload ? "200" : "200";

		responses[status] = {
			description: describeStatus(status),
			schema: payload ? factory.fromType(payload) : undefined,
		};
	}

	for (const attribute of findAttributes(attributes, "Produces")) {
		const payload =
			attributeGenericArgument(attribute) ??
			attributeArguments(attribute).match(/typeof\s*\(([^)]*)\)/)?.[1];
		if (!payload) continue;
		responses["200"] = {
			description: describeStatus("200"),
			schema: factory.fromType(payload.trim()),
		};
	}

	if (Object.keys(responses).length === 0) {
		const unwrapped = returnType ? factory.unwrapReturnType(returnType) : null;
		if (!unwrapped) return undefined;
		return {
			"200": { description: "Success", schema: factory.fromType(unwrapped) },
		};
	}

	return responses;
}

// ── Controllers ───────────────────────────────────────────────────────────────

interface ControllerContext {
	file: string;
	content: string;
	relativePath: string;
	factory: SchemaFactory;
	types: Map<string, TypeDeclaration>;
}

function detectControllerRoutes(context: ControllerContext): DetectedRoute[] {
	const { content } = context;
	const routes: DetectedRoute[] = [];
	const classRe = /\bclass\s+(\w+)/g;
	let classMatch: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((classMatch = classRe.exec(content)) !== null) {
		const className = classMatch[1];
		const bodyStart = content.indexOf("{", classMatch.index);
		if (bodyStart === -1) continue;
		const declarationStart =
			content.lastIndexOf("\n", classMatch.index) + 1;
		const annotations = collectAnnotations(content, declarationStart);
		const isController =
			className.endsWith("Controller") ||
			hasAttribute(annotations.attributes, "ApiController");
		if (!isController) continue;

		const bodyEnd = findMatching(content, bodyStart, "{", "}");
		const body = content.slice(bodyStart + 1, bodyEnd);
		classRe.lastIndex = bodyEnd;

		const controllerName = className.replace(/Controller$/, "");
		const apiVersion = findAttributes(annotations.attributes, "ApiVersion")
			.map((attribute) => stringLiterals(attributeArguments(attribute))[0])
			.find(Boolean);

		const routeAttribute = findAttributes(annotations.attributes, "Route")[0];
		const classTemplate = routeAttribute
			? (attributeTemplate(routeAttribute) ?? controllerName)
			: controllerName;

		const classTag =
			findAttributes(annotations.attributes, "Tags")
				.map((attribute) => stringLiterals(attributeArguments(attribute))[0])
				.find(Boolean) ?? controllerName;

		const classRequiresAuth = hasAttribute(annotations.attributes, "Authorize");

		for (const member of controllerMembers(body)) {
			routes.push(
				...buildControllerRoutes(member, {
					...context,
					body,
					classTemplate,
					controllerName,
					classTag,
					classRequiresAuth,
					apiVersion,
				}),
			);
		}
	}

	return routes;
}

interface ControllerMember {
	declarationStart: number;
	signatureEnd: number;
	name: string;
	returnType: string;
	parameters: string[];
}

/** Every method in the class body carrying at least one `[HttpVerb]`. */
function controllerMembers(body: string): ControllerMember[] {
	const members: ControllerMember[] = [];
	const seen = new Set<number>();
	const verbRe = new RegExp(`\\[Http(${HTTP_VERBS.join("|")})\\b`, "g");
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = verbRe.exec(body)) !== null) {
		let cursor = match.index;
		// Walk past the whole attribute run to reach the declaration itself.
		while (cursor < body.length) {
			if (/\s/.test(body[cursor])) {
				cursor++;
				continue;
			}
			if (body[cursor] === "[") {
				cursor = findMatching(body, cursor, "[", "]") + 1;
				continue;
			}
			if (body[cursor] === "/" && body[cursor + 1] === "/") {
				const eol = body.indexOf("\n", cursor);
				cursor = eol === -1 ? body.length : eol + 1;
				continue;
			}
			break;
		}
		if (cursor >= body.length || seen.has(cursor)) continue;

		const parenIndex = body.indexOf("(", cursor);
		if (parenIndex === -1) continue;
		const header = body.slice(cursor, parenIndex);
		if (/[;{}]/.test(header)) continue;

		const nameMatch = header.match(/(\w+)\s*(?:<[^<>]*>)?\s*$/);
		if (!nameMatch) continue;
		const returnType = header
			.slice(0, header.lastIndexOf(nameMatch[1]))
			.replace(
				/\b(?:public|private|protected|internal|static|async|virtual|override|sealed|new|partial)\b/g,
				"",
			)
			.trim();

		const parenEnd = findMatching(body, parenIndex, "(", ")");
		seen.add(cursor);
		members.push({
			declarationStart: cursor,
			signatureEnd: parenEnd,
			name: nameMatch[1],
			returnType,
			parameters: splitTopLevel(body.slice(parenIndex + 1, parenEnd)),
		});
		verbRe.lastIndex = parenEnd;
	}

	return members;
}

interface MemberContext extends ControllerContext {
	body: string;
	classTemplate: string;
	controllerName: string;
	classTag: string;
	classRequiresAuth: boolean;
	apiVersion?: string;
}

function buildControllerRoutes(
	member: ControllerMember,
	context: MemberContext,
): DetectedRoute[] {
	const annotations = collectAnnotations(context.body, member.declarationStart);
	if (ignoresApi(annotations.attributes)) return [];

	const doc = parseXmlDoc(annotations.doc);
	const memberRoute = findAttributes(annotations.attributes, "Route")
		.map((attribute) => attributeTemplate(attribute))
		.find((template): template is string => template !== null);

	const routes: DetectedRoute[] = [];
	const requiresAuth =
		(context.classRequiresAuth ||
			hasAttribute(annotations.attributes, "Authorize")) &&
		!hasAttribute(annotations.attributes, "AllowAnonymous");
	const deprecated = hasAttribute(annotations.attributes, "Obsolete");
	const tag =
		findAttributes(annotations.attributes, "Tags")
			.map((attribute) => stringLiterals(attributeArguments(attribute))[0])
			.find(Boolean) ?? context.classTag;

	for (const verb of HTTP_VERBS) {
		for (const attribute of findAttributes(
			annotations.attributes,
			`Http${verb}`,
		)) {
			const template = attributeTemplate(attribute) ?? memberRoute ?? "";
			const combined = substituteTokens(
				combineTemplates(context.classTemplate, template),
				{
					controller: context.controllerName,
					action: member.name,
					version: context.apiVersion,
				},
			);
			const normalized = normalizeRouteTemplate(combined);
			const routeParameterNames = new Set(
				normalized.parameters.map((parameter) => parameter.name.toLowerCase()),
			);

			const bound = bindParameters(member.parameters, {
				verb: verb.toUpperCase(),
				routeParameterNames,
				docParams: doc.params,
				types: context.types,
				factory: context.factory,
			});

			routes.push({
				path: normalized.path,
				methods: [verb.toUpperCase()],
				summary: doc.summary,
				description: doc.description,
				tag,
				file: context.relativePath,
				framework: FRAMEWORK,
				requiresAuth,
				deprecated: deprecated || undefined,
				parameters: mergeParameters(normalized.parameters, bound.parameters),
				requestBody: bound.requestBody,
				responses: buildResponses(
					annotations.attributes,
					member.returnType,
					context.factory,
				),
			});
		}
	}

	return routes;
}

/** Route tokens ASP.NET substitutes at startup rather than at request time. */
function substituteTokens(
	template: string,
	tokens: { controller: string; action: string; version?: string },
): string {
	let result = template
		.replace(/\[controller\]/gi, tokens.controller)
		.replace(/\[action\]/gi, tokens.action);
	if (tokens.version) {
		result = result.replace(/\{version:apiVersion\}/gi, tokens.version);
	}
	return result;
}

/**
 * Route template parameters carry the constraint's type; signature parameters
 * carry the C# type and the documented description. The signature wins, the
 * template fills the gaps.
 */
function mergeParameters(
	fromTemplate: RouteTemplateParameter[],
	fromSignature: RouteParameter[],
): RouteParameter[] {
	const merged: RouteParameter[] = [];
	const bound = new Map(
		fromSignature
			.filter((parameter) => parameter.in === "path")
			.map((parameter) => [parameter.name.toLowerCase(), parameter]),
	);

	for (const template of fromTemplate) {
		const signature = bound.get(template.name.toLowerCase());
		merged.push({
			name: template.name,
			in: "path",
			required: true,
			schema: signature?.schema ?? template.schema,
			description: signature?.description,
		});
	}

	for (const parameter of fromSignature) {
		if (parameter.in === "path") continue;
		merged.push(parameter);
	}

	return merged;
}

// ── Minimal APIs ──────────────────────────────────────────────────────────────

interface RouteGroup {
	receiver: string;
	template: string;
	requiresAuth: boolean;
	tag?: string;
}

function detectMinimalApiRoutes(context: ControllerContext): DetectedRoute[] {
	const { content } = context;
	const routes: DetectedRoute[] = [];

	const groups = new Map<string, RouteGroup>();
	const groupRe = /(?:var|const)\s+(\w+)\s*=\s*(\w+)\s*\.\s*MapGroup\s*\(/g;
	let groupMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((groupMatch = groupRe.exec(content)) !== null) {
		const open = groupMatch.index + groupMatch[0].length - 1;
		const close = findMatching(content, open, "(", ")");
		const statementEnd = findStatementEnd(content, close);
		const chain = content.slice(close + 1, statementEnd);
		groups.set(groupMatch[1], {
			receiver: groupMatch[2],
			template: unquote(splitTopLevel(content.slice(open + 1, close))[0] ?? ""),
			requiresAuth: /\.RequireAuthorization\s*\(/.test(chain),
			tag: chainTag(chain),
		});
	}

	const endpointRe = new RegExp(
		`(\\w+)\\s*\\.\\s*Map(${HTTP_VERBS.join("|")}|Methods)\\s*\\(`,
		"g",
	);
	let endpointMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((endpointMatch = endpointRe.exec(content)) !== null) {
		const open = endpointMatch.index + endpointMatch[0].length - 1;
		const close = findMatching(content, open, "(", ")");
		const args = splitTopLevel(content.slice(open + 1, close));
		if (args.length === 0) continue;
		const template = unquote(args[0]);
		if (!args[0].trim().startsWith("\"")) continue;

		const statementEnd = findStatementEnd(content, close);
		const chain = content.slice(close + 1, statementEnd);
		endpointRe.lastIndex = close;

		const receiver = endpointMatch[1];
		const group = resolveGroup(receiver, groups);
		const methods =
			endpointMatch[2] === "Methods"
				? stringLiterals(args[1] ?? "").map((verb) => verb.toUpperCase())
				: [endpointMatch[2].toUpperCase()];
		if (methods.length === 0) continue;

		const handler = args[endpointMatch[2] === "Methods" ? 2 : 1] ?? "";
		const handlerParameters = lambdaParameters(handler);

		const normalized = normalizeRouteTemplate(
			joinTemplates(group.template, template),
		);
		const routeParameterNames = new Set(
			normalized.parameters.map((parameter) => parameter.name.toLowerCase()),
		);

		const requiresAuth =
			(group.requiresAuth || /\.RequireAuthorization\s*\(/.test(chain)) &&
			!/\.AllowAnonymous\s*\(/.test(chain);

		for (const method of methods) {
			const bound = bindParameters(handlerParameters, {
				verb: method,
				routeParameterNames,
				docParams: {},
				types: context.types,
				factory: context.factory,
			});

			routes.push({
				path: normalized.path,
				methods: [method],
				summary: chainText(chain, "WithSummary"),
				description: chainText(chain, "WithDescription"),
				tag:
					chainTag(chain) ??
					group.tag ??
					normalized.path.split("/").filter(Boolean)[0] ??
					"minimal-api",
				file: context.relativePath,
				framework: FRAMEWORK,
				requiresAuth,
				parameters: mergeParameters(normalized.parameters, bound.parameters),
				requestBody: bound.requestBody,
				responses: chainResponses(chain, context.factory),
			});
		}
	}

	return routes;
}

/** Resolves a group variable to its full prefix, following nested groups. */
function resolveGroup(
	receiver: string,
	groups: Map<string, RouteGroup>,
): RouteGroup {
	const chain: RouteGroup[] = [];
	const seen = new Set<string>();
	let current = receiver;
	while (groups.has(current) && !seen.has(current)) {
		seen.add(current);
		const group = groups.get(current) as RouteGroup;
		chain.unshift(group);
		current = group.receiver;
	}
	return {
		receiver: current,
		template: chain.map((group) => group.template).join("/"),
		requiresAuth: chain.some((group) => group.requiresAuth),
		tag: chain.map((group) => group.tag).filter(Boolean).pop(),
	};
}

function chainTag(chain: string): string | undefined {
	const match = chain.match(/\.WithTags\s*\(([^)]*)\)/);
	if (!match) return undefined;
	return stringLiterals(match[1])[0];
}

function chainText(chain: string, call: string): string | undefined {
	const match = chain.match(new RegExp(`\\.${call}\\s*\\(([^)]*)\\)`));
	if (!match) return undefined;
	return stringLiterals(match[1])[0];
}

function chainResponses(
	chain: string,
	factory: SchemaFactory,
): Record<string, RouteResponse> | undefined {
	const responses: Record<string, RouteResponse> = {};
	const producesRe = /\.Produces(?:<([^>]+)>)?\s*\(([^)]*)\)/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = producesRe.exec(chain)) !== null) {
		const status =
			match[2].match(/Status(\d{3})/)?.[1] ??
			match[2].match(/\b(\d{3})\b/)?.[1] ??
			"200";
		responses[status] = {
			description: describeStatus(status),
			schema: match[1] ? factory.fromType(match[1].trim()) : undefined,
		};
	}
	return Object.keys(responses).length > 0 ? responses : undefined;
}

/** The parameter list of the lambda handed to `MapGet` and friends. */
function lambdaParameters(handler: string): string[] {
	const text = handler.trim().replace(/^async\s+/, "");
	if (text.startsWith("(")) {
		const end = findMatching(text, 0, "(", ")");
		if (!/^\s*=>/.test(text.slice(end + 1))) return [];
		return splitTopLevel(text.slice(1, end));
	}
	const bare = text.match(/^(\w+)\s*=>/);
	return bare ? [bare[1]] : [];
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function detectDotnet(projectPath: string): ScanResult {
	const files = walkFiles(projectPath, [".cs"]);
	const sources: Array<{ file: string; content: string }> = [];
	for (const file of files) {
		const content = readFile(file);
		if (content) sources.push({ file, content });
	}

	const types = indexTypeDeclarations(sources.map((source) => source.content));
	const factory = new SchemaFactory(types);
	const routes: DetectedRoute[] = [];

	for (const source of sources) {
		const context: ControllerContext = {
			file: source.file,
			content: source.content,
			relativePath: path.relative(projectPath, source.file),
			factory,
			types,
		};
		if (/class\s+\w*Controller\b|\[ApiController\]/.test(source.content)) {
			routes.push(...detectControllerRoutes(context));
		}
		if (/\.\s*Map(Get|Post|Put|Delete|Patch|Head|Options|Methods)\s*\(/.test(source.content)) {
			routes.push(...detectMinimalApiRoutes(context));
		}
	}

	return { routes, schemas: factory.schemas, filesScanned: sources.length };
}
