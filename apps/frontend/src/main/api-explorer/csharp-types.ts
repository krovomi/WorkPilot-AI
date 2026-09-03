import {
	attributeArguments,
	attributeName,
	collectAnnotations,
	findMatching,
	parseXmlDoc,
	splitTopLevel,
	unquote,
} from "./csharp-syntax";
import type { JsonSchema } from "./types";

export interface TypeDeclaration {
	kind: "class" | "record" | "struct" | "interface" | "enum";
	name: string;
	typeParameters: string[];
	/** Parameter list of a positional record, without its parentheses. */
	positional?: string;
	/** Declaration body, without its braces. */
	body?: string;
}

const DECLARATION_KEYWORDS = new Set([
	"where",
	"new",
	"class",
	"record",
	"struct",
	"interface",
	"enum",
	"base",
	"this",
]);

/**
 * Indexes every type declared in the scanned C# sources, so a DTO named by a
 * controller action can be turned into a schema without a second pass over the
 * file system.
 */
export function indexTypeDeclarations(
	sources: Iterable<string>,
): Map<string, TypeDeclaration> {
	const types = new Map<string, TypeDeclaration>();
	const declarationRe =
		/\b(class|record|struct|interface|enum)\s+(?:(?:struct|class)\s+)?(\w+)/g;

	for (const content of sources) {
		let match: RegExpExecArray | null;
		declarationRe.lastIndex = 0;
		// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
		while ((match = declarationRe.exec(content)) !== null) {
			const name = match[2];
			if (DECLARATION_KEYWORDS.has(name) || types.has(name)) continue;

			const lineStart = content.lastIndexOf("\n", match.index) + 1;
			const line = content.slice(lineStart, match.index).trim();
			if (line.startsWith("//") || line.startsWith("*")) continue;

			let cursor = match.index + match[0].length;
			const typeParameters: string[] = [];
			if (content[cursor] === "<") {
				const end = findMatching(content, cursor, "<", ">");
				typeParameters.push(
					...splitTopLevel(content.slice(cursor + 1, end))
						.map((param) => param.split(/\s+/).pop())
						.filter((param): param is string => Boolean(param)),
				);
				cursor = end + 1;
			}

			let positional: string | undefined;
			while (cursor < content.length && /\s/.test(content[cursor])) cursor++;
			if (content[cursor] === "(") {
				const end = findMatching(content, cursor, "(", ")");
				positional = content.slice(cursor + 1, end);
				cursor = end + 1;
			}

			// Skip the base list and the generic constraints to reach the body.
			const bodyStart = content.indexOf("{", cursor);
			const statementEnd = content.indexOf(";", cursor);
			let body: string | undefined;
			if (
				bodyStart !== -1 &&
				(statementEnd === -1 || bodyStart < statementEnd) &&
				!content.slice(cursor, bodyStart).includes("}")
			) {
				const end = findMatching(content, bodyStart, "{", "}");
				body = content.slice(bodyStart + 1, end);
			}

			types.set(name, {
				kind: match[1] as TypeDeclaration["kind"],
				name,
				typeParameters,
				positional,
				body,
			});
		}
	}
	return types;
}

const PRIMITIVE_SCHEMAS: Record<string, JsonSchema> = {
	byte: { type: "integer", format: "int32" },
	sbyte: { type: "integer", format: "int32" },
	short: { type: "integer", format: "int32" },
	ushort: { type: "integer", format: "int32" },
	int: { type: "integer", format: "int32" },
	int16: { type: "integer", format: "int32" },
	int32: { type: "integer", format: "int32" },
	uint: { type: "integer", format: "int32" },
	long: { type: "integer", format: "int64" },
	int64: { type: "integer", format: "int64" },
	ulong: { type: "integer", format: "int64" },
	float: { type: "number", format: "float" },
	single: { type: "number", format: "float" },
	double: { type: "number", format: "double" },
	decimal: { type: "number", format: "double" },
	bool: { type: "boolean" },
	boolean: { type: "boolean" },
	string: { type: "string" },
	char: { type: "string" },
	guid: { type: "string", format: "uuid" },
	datetime: { type: "string", format: "date-time" },
	datetimeoffset: { type: "string", format: "date-time" },
	dateonly: { type: "string", format: "date" },
	timeonly: { type: "string" },
	timespan: { type: "string" },
	uri: { type: "string", format: "uri" },
	object: { type: "object" },
	dynamic: { type: "object" },
	stream: { type: "string", format: "binary" },
	iformfile: { type: "string", format: "binary" },
};

const COLLECTION_TYPES = new Set([
	"list",
	"ilist",
	"icollection",
	"ienumerable",
	"iasyncenumerable",
	"ireadonlylist",
	"ireadonlycollection",
	"collection",
	"hashset",
	"iset",
	"queue",
	"stack",
	"array",
]);

const DICTIONARY_TYPES = new Set([
	"dictionary",
	"idictionary",
	"ireadonlydictionary",
	"sorteddictionary",
	"concurrentdictionary",
]);

/** Wrappers that carry a payload the caller actually sees. */
const TRANSPARENT_TYPES = new Set([
	"task",
	"valuetask",
	"actionresult",
	"ok",
	"created",
	"createdatroute",
	"jsonresult",
	"okobjectresult",
]);

/** Return types that say nothing about the payload. */
const OPAQUE_TYPES = new Set([
	"iactionresult",
	"iresult",
	"actionresult",
	"void",
	"task",
	"valuetask",
	"results",
	"okresult",
	"nocontentresult",
	"contentresult",
	"filecontentresult",
	"fileresult",
	"problemdetails",
]);

export interface ParsedType {
	/** Type name without namespace, generic arguments or nullable marker. */
	name: string;
	genericArguments: string[];
	isNullable: boolean;
	isArray: boolean;
}

/**
 * Splits a C# type reference into its parts.
 *
 * The array suffix — `[]` through `[ , , ]` — is matched with the comma group
 * entered only on a literal `,`. The obvious `\s*,*\s*` lets the whitespace of
 * a bracket be split two ways, and two parses per bracket is exponential over
 * a type whose brackets never close.
 */
export function parseTypeName(raw: string): ParsedType {
	let text = raw.trim().replace(/^global::/, "");
	let isNullable = false;
	let isArray = false;

	while (text.endsWith("?")) {
		isNullable = true;
		text = text.slice(0, -1).trim();
	}
	while (/\[\s*(?:,\s*)*\]$/.test(text)) {
		isArray = true;
		text = text.replace(/\[\s*(?:,\s*)*\]$/, "").trim();
		while (text.endsWith("?")) text = text.slice(0, -1).trim();
	}

	let genericArguments: string[] = [];
	const open = text.indexOf("<");
	if (open !== -1 && text.endsWith(">")) {
		genericArguments = splitTopLevel(text.slice(open + 1, -1));
		text = text.slice(0, open);
	}

	const name = (text.split(".").pop() ?? text).trim();
	return { name, genericArguments, isNullable, isArray };
}

/** True for types bound from the URL rather than from the request body. */
export function isSimpleType(
	raw: string,
	types: Map<string, TypeDeclaration>,
): boolean {
	const parsed = parseTypeName(raw);
	if (parsed.name.toLowerCase() === "nullable") {
		return parsed.genericArguments.every((arg) => isSimpleType(arg, types));
	}
	if (parsed.isArray) return isSimpleType(parsed.name, types);
	if (COLLECTION_TYPES.has(parsed.name.toLowerCase())) {
		return isSimpleType(parsed.genericArguments[0] ?? "string", types);
	}
	if (PRIMITIVE_SCHEMAS[parsed.name.toLowerCase()]) return true;
	return types.get(parsed.name)?.kind === "enum";
}

/**
 * Turns C# type names into JSON Schema, registering every user-defined type it
 * meets under `schemas` so the document can reference them with `$ref`.
 */
export class SchemaFactory {
	readonly schemas: Record<string, JsonSchema> = {};
	private readonly types: Map<string, TypeDeclaration>;

	constructor(types: Map<string, TypeDeclaration>) {
		this.types = types;
	}

	/** Strips `Task<>`, `ActionResult<>` and friends off a return type. */
	unwrapReturnType(raw: string): string | null {
		const parsed = parseTypeName(raw);
		const lower = parsed.name.toLowerCase();
		if (TRANSPARENT_TYPES.has(lower) && parsed.genericArguments.length === 1) {
			return this.unwrapReturnType(parsed.genericArguments[0]);
		}
		if (OPAQUE_TYPES.has(lower) && parsed.genericArguments.length === 0) {
			return null;
		}
		return raw.trim();
	}

	fromType(
		raw: string,
		substitutions: Record<string, string> = {},
	): JsonSchema {
		return this.build(raw, substitutions, new Set());
	}

	private build(
		raw: string,
		substitutions: Record<string, string>,
		stack: Set<string>,
	): JsonSchema {
		const substituted = substitutions[raw.trim()] ?? raw;
		const parsed = parseTypeName(substituted);
		const lower = parsed.name.toLowerCase();

		if (lower === "nullable" && parsed.genericArguments.length === 1) {
			return {
				...this.build(parsed.genericArguments[0], substitutions, stack),
				nullable: true,
			};
		}

		if (parsed.isArray) {
			if (lower === "byte") return { type: "string", format: "byte" };
			const item = substituted.replace(/\?*\s*\[\s*(?:,\s*)*\]\s*$/, "");
			return { type: "array", items: this.build(item, substitutions, stack) };
		}

		if (COLLECTION_TYPES.has(lower) && parsed.genericArguments.length >= 1) {
			return {
				type: "array",
				items: this.build(parsed.genericArguments[0], substitutions, stack),
			};
		}

		if (DICTIONARY_TYPES.has(lower) && parsed.genericArguments.length === 2) {
			return {
				type: "object",
				additionalProperties: this.build(
					parsed.genericArguments[1],
					substitutions,
					stack,
				),
			};
		}

		const primitive = PRIMITIVE_SCHEMAS[lower];
		if (primitive) {
			return parsed.isNullable ? { ...primitive, nullable: true } : primitive;
		}

		const declaration = this.types.get(parsed.name);
		if (!declaration) return { type: "object" };

		const schemaName = this.schemaName(parsed);
		if (this.schemas[schemaName] === undefined) {
			stack.add(schemaName);
			// Reserve the name before recursing, so a self-referencing DTO
			// resolves to a `$ref` instead of looping.
			this.schemas[schemaName] = { type: "object" };
			this.schemas[schemaName] = this.buildDeclaration(
				declaration,
				parsed.genericArguments,
				stack,
			);
			stack.delete(schemaName);
		}
		return { $ref: refOf(schemaName) };
	}

	private schemaName(parsed: ParsedType): string {
		if (parsed.genericArguments.length === 0) return parsed.name;
		const args = parsed.genericArguments
			.map((arg) => parseTypeName(arg).name)
			.join("And");
		return `${parsed.name}Of${args}`;
	}

	private buildDeclaration(
		declaration: TypeDeclaration,
		genericArguments: string[],
		stack: Set<string>,
	): JsonSchema {
		if (declaration.kind === "enum") {
			return { type: "string", enum: enumMembers(declaration.body ?? "") };
		}

		const substitutions: Record<string, string> = {};
		declaration.typeParameters.forEach((param, index) => {
			if (genericArguments[index]) {
				substitutions[param] = genericArguments[index];
			}
		});

		const properties: Record<string, JsonSchema> = {};
		const required: string[] = [];

		for (const member of declarationMembers(declaration)) {
			const schema = this.build(member.type, substitutions, stack);
			properties[member.jsonName] = member.description
				? { ...schema, description: member.description }
				: schema;
			if (member.required) required.push(member.jsonName);
		}

		const schema: JsonSchema = { type: "object", properties };
		if (required.length > 0) schema.required = required;
		return schema;
	}
}

export function refOf(schemaName: string): string {
	return `#/components/schemas/${schemaName}`;
}

interface DeclarationMember {
	jsonName: string;
	type: string;
	required: boolean;
	description?: string;
}

function enumMembers(body: string): string[] {
	return splitTopLevel(body)
		.map((member) => member.replace(/\[[^\]]*\]/g, "").trim())
		.map((member) => member.split("=")[0].trim())
		.filter((member) => /^\w+$/.test(member));
}

/**
 * The serialized members of a class, struct or record declaration.
 *
 * The property pattern avoids a lazy `[…\s]+?` type class: paired with the
 * `\s+` that follows it, that shape backtracks quadratically over a long line
 * that never reaches the `{ get` lookahead. It is also kept as a literal —
 * inside a template literal, `\s` reads as a useless escape the formatter
 * removes on sight, which would quietly defuse the pattern. Its array suffix
 * is the unambiguous one `parseTypeName` documents, for the same reason.
 */
function declarationMembers(declaration: TypeDeclaration): DeclarationMember[] {
	const members: DeclarationMember[] = [];

	for (const parameter of splitTopLevel(declaration.positional ?? "")) {
		const parsed = parseParameterDeclaration(parameter);
		if (!parsed) continue;
		members.push({
			jsonName: jsonPropertyName(parsed.name, parsed.attributes),
			type: parsed.type,
			required: !parsed.type.trim().endsWith("?") && !parsed.hasDefault,
		});
	}

	const body = declaration.body ?? "";
	const propertyRe =
		/(?:^|\n)[ \t]*public\s+((?:(?:virtual|override|new|required|sealed|readonly|static|const|abstract|extern|unsafe)\s+)*)([\w.]+(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(?:\?|\[\s*(?:,\s*)*\])*)\s+(\w+)\s*(?=\{\s*(?:get|set|init))/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: intentional assignment
	while ((match = propertyRe.exec(body)) !== null) {
		const modifiers = match[1];
		if (/\b(?:static|const)\b/.test(modifiers)) continue;
		const annotations = collectAnnotations(
			body,
			match.index + match[0].indexOf("public"),
		);
		const doc = parseXmlDoc(annotations.doc);
		members.push({
			jsonName: jsonPropertyName(match[3], annotations.attributes),
			type: match[2].trim(),
			required:
				/\brequired\b/.test(modifiers) ||
				annotations.attributes.some(
					(attribute) => attributeName(attribute) === "Required",
				),
			description: doc.summary,
		});
	}

	return members.filter(
		(member, index, all) =>
			all.findIndex((other) => other.jsonName === member.jsonName) === index,
	);
}

export interface ParsedParameter {
	name: string;
	type: string;
	attributes: string[];
	hasDefault: boolean;
}

/** Parses `[FromQuery] string? filter = "all"` into its parts. */
export function parseParameterDeclaration(
	text: string,
): ParsedParameter | null {
	let rest = text.trim();
	const attributes: string[] = [];
	while (rest.startsWith("[")) {
		const end = findMatching(rest, 0, "[", "]");
		for (const attribute of splitTopLevel(rest.slice(1, end))) {
			attributes.push(attribute);
		}
		rest = rest.slice(end + 1).trim();
	}

	rest = rest.replace(/^(?:this|params|ref|out|in|scoped)\s+/, "").trim();

	let hasDefault = false;
	const equals = rest.indexOf("=");
	if (equals !== -1) {
		hasDefault = true;
		rest = rest.slice(0, equals).trim();
	}

	const match = rest.match(/^(.*?[\s>\]?])\s*(\w+)$/s);
	if (!match) return null;
	const type = match[1].trim();
	if (!type) return null;

	return { name: match[2], type, attributes, hasDefault };
}

/**
 * The name the member is serialized under. `System.Text.Json` camel-cases by
 * default, and `[JsonPropertyName]` overrides it.
 */
export function jsonPropertyName(name: string, attributes: string[]): string {
	for (const attribute of attributes) {
		if (attributeName(attribute) !== "JsonPropertyName") continue;
		const value = unquote(attributeArguments(attribute));
		if (value) return value;
	}
	if (name.length === 0) return name;
	// An acronym-style name (`ID`, `URL`) is left alone: camel-casing only the
	// first letter would produce `iD`.
	if (
		name.length > 1 &&
		name[0] === name[0].toUpperCase() &&
		name[1] === name[1].toUpperCase()
	) {
		return name;
	}
	return name[0].toLowerCase() + name.slice(1);
}
