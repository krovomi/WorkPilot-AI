/**
 * Le chemin d'une tâche, en graphe : ce que la tâche a modifié, où, et comment
 * les morceaux se tiennent entre eux.
 *
 * La liste des fichiers d'un diff répond à « quoi ? » et jamais à « pourquoi
 * ensemble ? ». Une propriété ajoutée à une entité du Domain, reprise par un
 * DTO de l'Application, exposée par un contrôleur, vérifiée par un test : c'est
 * un chemin, et il se lit dans le diff lui-même — les déclarations ajoutées,
 * les noms qu'un fichier modifié cite d'un autre fichier modifié.
 *
 * Comme `emulator-landing.ts`, rien ici n'appelle de modèle ni de réseau : des
 * chemins et des lignes de patch. Le graphe est donc disponible dès qu'un diff
 * existe, sans coût, et il ne peut pas inventer une relation que le code ne
 * porte pas. Il est rendu au format node-link de Graphify
 * (`toGraphifyNodeLink`) pour que les outils qui lisent `graph.json` —
 * Graphify, le skill `graph-first-recall` — le lisent tel quel.
 */

/** Un fichier du diff de la tâche, tel que `getWorktreeDiff` le rend. */
export interface ChangeGraphFile {
	path: string;
	status?: "added" | "modified" | "deleted" | "renamed";
	additions?: number;
	deletions?: number;
	patch?: string;
}

/** Une sous-tâche du plan : ce qu'elle dit vouloir faire, et où. */
export interface ChangeGraphSubtask {
	id: string;
	title?: string;
	description?: string;
	files?: string[];
}

/**
 * Les couches, dans l'ordre où une fonctionnalité se construit en clean
 * architecture : du cœur vers l'extérieur, puis ce qui le vérifie.
 */
export const CHANGE_LAYERS = [
	"domain",
	"application",
	"infrastructure",
	"presentation",
	"tests",
	"config",
	"docs",
	"other",
] as const;
export type ChangeLayer = (typeof CHANGE_LAYERS)[number];

export type ChangeStatus = "added" | "modified" | "deleted";

/** Ce que la déclaration est, dans le langage. */
export type SymbolKind =
	| "class"
	| "interface"
	| "record"
	| "struct"
	| "enum"
	| "function"
	| "component"
	| "hook"
	| "module"
	| "file";

/** Ce que le nom dit du rôle — c'est lui qui donne le nom commun de la phrase. */
export type SymbolRole =
	| "dto"
	| "request"
	| "response"
	| "viewModel"
	| "command"
	| "query"
	| "handler"
	| "controller"
	| "repository"
	| "service"
	| "validator"
	| "mapper"
	| "migration"
	| "test"
	| "config"
	| "docs"
	| "style"
	| "translations";

export type MemberKind =
	| "property"
	| "method"
	| "field"
	| "constructor"
	| "function"
	| "value";

export interface MemberChange {
	name: string;
	kind: MemberKind;
	change: ChangeStatus;
}

export interface ChangeNode {
	id: string;
	/** Le nom affiché : la classe, le composant, ou le fichier. */
	name: string;
	kind: SymbolKind;
	role?: SymbolRole;
	layer: ChangeLayer;
	status: ChangeStatus;
	file: string;
	additions: number;
	deletions: number;
	members: MemberChange[];
	/** Les sous-tâches du plan qui déclarent ce fichier. */
	subtaskIds: string[];
}

export type EdgeRelation =
	| "inherits"
	| "implements"
	| "handles"
	| "tests"
	| "maps"
	| "uses";

export interface ChangeEdge {
	id: string;
	source: string;
	target: string;
	relation: EdgeRelation;
	/** La ligne du patch qui porte la relation — la preuve, pas une déduction. */
	evidence?: string;
	/** Les membres ajoutés des deux côtés : le chemin d'une même donnée. */
	sharedMembers: string[];
}

export interface ChangeGraph {
	nodes: ChangeNode[];
	edges: ChangeEdge[];
	/** Les couches effectivement présentes, dans l'ordre de `CHANGE_LAYERS`. */
	layers: ChangeLayer[];
	/** Fichiers écartés parce que personne ne les lit (lockfiles, snapshots…). */
	skippedFiles: string[];
	/** Fichiers au-delà du plafond, résumés plutôt que dessinés. */
	truncatedFiles: string[];
}

export interface BuildChangeGraphOptions {
	/** Nombre maximum de nœuds dessinés. Au-delà, le graphe ne se lit plus. */
	maxNodes?: number;
}

const DEFAULT_MAX_NODES = 60;

// ---------------------------------------------------------------------------
// Fichiers
// ---------------------------------------------------------------------------

/** Ce qu'aucun humain ne relit dans un diff : écrit par un outil. */
const GENERATED_FILE =
	/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|uv\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|packages\.lock\.json)$|\.min\.(?:js|css)$|\.snap$|\.map$|(?:^|\/)graphify-out\//i;

type Language = "csharp" | "jvm" | "ts" | "python" | "go" | "rust" | "other";

function languageOf(path: string): Language {
	const lower = path.toLowerCase();
	if (/\.(?:cs|razor)$/.test(lower)) return "csharp";
	if (/\.(?:java|kt|kts|scala|swift|dart)$/.test(lower)) return "jvm";
	if (/\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(lower)) return "ts";
	if (/\.py$/.test(lower)) return "python";
	if (/\.go$/.test(lower)) return "go";
	if (/\.rs$/.test(lower)) return "rust";
	return "other";
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

function stem(path: string): string {
	return basename(path).replace(/\.[^.]+$/, "");
}

/**
 * La couche d'un fichier, lue dans son chemin.
 *
 * Les tests passent en premier : `UserProfile.Tests/Domain/UserProfileTests.cs`
 * vérifie le Domain, il n'en fait pas partie. Viennent ensuite les noms de
 * projets d'une solution clean architecture — les plus sûrs — puis les dossiers
 * qui le suggèrent seulement.
 */
export function layerOf(path: string): ChangeLayer {
	const p = `/${path.replace(/\\/g, "/").toLowerCase()}`;
	const file = basename(p);
	// La casse d'origine : `UserTests.cs` est un test, `Contest.cs` n'en est pas un.
	const original = basename(path.replace(/\\/g, "/"));

	if (
		/[/.](?:tests?|specs?|__tests__|testing|e2e|integrationtests|unittests)\//.test(
			p,
		) ||
		/\.(?:test|spec)\.[^.]+$/.test(file) ||
		/(?:^test_.*|_test)\.(?:py|go)$/.test(file) ||
		/(?:Tests?|Specs?)\.(?:cs|java|kt)$/.test(original)
	)
		return "tests";
	if (/\.(?:md|mdx|rst|adoc|txt)$/.test(file)) return "docs";

	const strong: Array<[RegExp, ChangeLayer]> = [
		[/[/.]domain(?:\.[\w]+)?\//, "domain"],
		// `MyApp.Core/` est le cœur d'une solution ; un dossier `core/` ne dit rien.
		[/\.core\//, "domain"],
		[/[/.]application\//, "application"],
		[/[/.](?:infrastructure|persistence|dataaccess)\//, "infrastructure"],
		[/[/.](?:api|web|webapi|presentation|ui|frontend|host)\//, "presentation"],
	];
	for (const [pattern, layer] of strong) if (pattern.test(p)) return layer;

	const weak: Array<[RegExp, ChangeLayer]> = [
		[/\/(?:entities|aggregates|valueobjects|domainevents|enums)\//, "domain"],
		[
			/\/(?:usecases|use-cases|services|handlers|commands|queries|dtos?|contracts|interfaces|validators|mappings?|features)\//,
			"application",
		],
		[
			/\/(?:repositories|migrations|data|db|database|configurations|clients|adapters|persistence)\//,
			"infrastructure",
		],
		[
			/\/(?:controllers|endpoints|routes|pages|views|components|renderer|screens|app|hooks|stores|layouts)\//,
			"presentation",
		],
		[/\/(?:models|model)\//, "domain"],
	];
	for (const [pattern, layer] of weak) if (pattern.test(p)) return layer;

	if (
		/\.(?:json|ya?ml|toml|ini|env|csproj|sln|props|targets|xml|config|lock|gradle|properties)$/.test(
			file,
		) ||
		/(?:^|\/)(?:dockerfile|makefile)$/.test(p)
	)
		return "config";
	return "other";
}

/** Le rôle que le nom annonce. Le suffixe est une convention, pas une devinette. */
export function roleOf(name: string, path: string): SymbolRole | undefined {
	const p = path.replace(/\\/g, "/").toLowerCase();
	if (/\/migrations\//.test(p)) return "migration";
	if (/\/locales?\/|\/i18n\//.test(p) && /\.json$/.test(p)) return "translations";
	if (/\.(?:css|scss|sass|less)$/.test(p)) return "style";
	const rules: Array<[RegExp, SymbolRole]> = [
		[/(?:Tests?|Spec|Specs)$/, "test"],
		[/(?:Dto|DTO)$/, "dto"],
		[/ViewModel$|Vm$/, "viewModel"],
		[/Request$/, "request"],
		[/Response$/, "response"],
		[/CommandHandler$|QueryHandler$|Handler$/, "handler"],
		[/Command$/, "command"],
		[/Query$/, "query"],
		[/Controller$|Endpoints?$/, "controller"],
		[/Repository$|Repo$/, "repository"],
		[/Service$/, "service"],
		[/Validator$/, "validator"],
		[/Mapper$|MappingProfile$|Mappings?$/, "mapper"],
	];
	for (const [pattern, role] of rules) if (pattern.test(name)) return role;
	return undefined;
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

type LineSide = "+" | "-" | " ";

interface PatchLine {
	side: LineSide;
	text: string;
	/** Le texte de l'en-tête `@@ … @@ <contexte>` du bloc qui porte la ligne. */
	hunkContext: string;
	/** Première ligne d'un bloc : c'est là que l'en-tête s'applique. */
	hunkStart: boolean;
}

function parsePatch(patch: string | undefined): PatchLine[] {
	if (!patch) return [];
	const lines: PatchLine[] = [];
	let context = "";
	let start = false;
	for (const raw of patch.split(/\r?\n/)) {
		if (
			raw.startsWith("diff --git") ||
			raw.startsWith("index ") ||
			raw.startsWith("--- ") ||
			raw.startsWith("+++ ") ||
			raw.startsWith("new file mode") ||
			raw.startsWith("deleted file mode") ||
			raw.startsWith("similarity index") ||
			raw.startsWith("rename ") ||
			raw.startsWith("\\")
		)
			continue;
		const hunk = /^@@[^@]*@@\s?(.*)$/.exec(raw);
		if (hunk) {
			context = hunk[1] ?? "";
			start = true;
			continue;
		}
		const side = raw[0];
		if (side !== "+" && side !== "-" && side !== " ") continue;
		lines.push({ side, text: raw.slice(1), hunkContext: context, hunkStart: start });
		start = false;
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Déclarations
// ---------------------------------------------------------------------------

interface TypeDecl {
	name: string;
	kind: SymbolKind;
	/** Ce qui suit le nom : la liste des bases (`: IFoo`, `extends Bar`). */
	bases: string;
	/** Les paramètres d'un record positionnel : autant de propriétés. */
	positional?: Array<{ name: string }>;
}

const JVM_CS_TYPE =
	/^\s*(?:\[[^\]]*\]\s*)*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly|final|open|data|export|file|unsafe|ref|inner|value)\s+)*(record\s+(?:struct|class)|class|interface|record|struct|enum(?:\s+class)?|object)\s+([A-Za-z_]\w*)(.*)$/;

const TS_TYPE =
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+([A-Za-z_$][\w$]*)(.*)$/;

const PY_CLASS = /^class\s+([A-Za-z_]\w*)(.*)$/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b(.*)$/;
const RUST_TYPE =
	/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)(.*)$/;

function kindFromKeyword(keyword: string): SymbolKind {
	const k = keyword.toLowerCase();
	if (k.startsWith("record")) return "record";
	if (k === "interface" || k === "trait") return "interface";
	if (k === "struct") return "struct";
	if (k.startsWith("enum")) return "enum";
	return "class";
}

function splitParams(list: string): Array<{ name: string }> {
	const params: Array<{ name: string }> = [];
	let depth = 0;
	let current = "";
	for (const char of list) {
		if (char === "<" || char === "(" || char === "[") depth++;
		if (char === ">" || char === ")" || char === "]") depth--;
		if (char === "," && depth === 0) {
			params.push({ name: current });
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) params.push({ name: current });
	return params
		.map((p) => {
			let cleaned = p.name.replace(/=.*$/, "").replace(/\[[^\]]*\]/g, "").trim();
			// Kotlin et Scala écrivent le nom avant le type : `val name: String`.
			if (cleaned.includes(":")) cleaned = cleaned.split(":")[0]?.trim() ?? "";
			const tokens = cleaned.split(/\s+/);
			return { name: tokens[tokens.length - 1] ?? "" };
		})
		.filter((p) => /^[A-Za-z_]\w*$/.test(p.name));
}

function parseTypeDecl(text: string, language: Language): TypeDecl | null {
	if (language === "csharp" || language === "jvm") {
		const m = JVM_CS_TYPE.exec(text);
		if (!m) return null;
		const rest = m[3] ?? "";
		const kind = kindFromKeyword(m[1] ?? "class");
		let positional: TypeDecl["positional"];
		const paren = /^\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(rest);
		if (paren && (kind === "record" || language === "jvm")) {
			positional = splitParams(paren[1] ?? "");
		}
		return { name: m[2] ?? "", kind, bases: rest, positional };
	}
	if (language === "ts") {
		const m = TS_TYPE.exec(text);
		if (!m) return null;
		const keyword = m[1] ?? "class";
		if (keyword === "type" && !/^\s*(?:<[^>]*>)?\s*=/.test(m[3] ?? ""))
			return null;
		return {
			name: m[2] ?? "",
			kind: keyword === "type" ? "interface" : kindFromKeyword(keyword),
			bases: m[3] ?? "",
		};
	}
	if (language === "python") {
		const m = PY_CLASS.exec(text);
		return m ? { name: m[1] ?? "", kind: "class", bases: m[2] ?? "" } : null;
	}
	if (language === "go") {
		const m = GO_TYPE.exec(text);
		return m
			? { name: m[1] ?? "", kind: kindFromKeyword(m[2] ?? ""), bases: m[3] ?? "" }
			: null;
	}
	if (language === "rust") {
		const m = RUST_TYPE.exec(text);
		return m
			? { name: m[2] ?? "", kind: kindFromKeyword(m[1] ?? ""), bases: m[3] ?? "" }
			: null;
	}
	return null;
}

/** Une fonction de haut niveau : un composant, un hook, ou une fonction. */
function parseTopLevelFunction(
	text: string,
	language: Language,
	path: string,
): { name: string; kind: SymbolKind } | null {
	let name: string | undefined;
	if (language === "ts") {
		name =
			/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(
				text,
			)?.[1] ??
			/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(
				text,
			)?.[1] ??
			/^(?:export\s+)?const\s+([A-Z][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef)\s*\(/.exec(
				text,
			)?.[1];
	} else if (language === "python") {
		name = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(text)?.[1];
	} else if (language === "go") {
		name = /^func\s+([A-Za-z_]\w*)\s*\(/.exec(text)?.[1];
	} else if (language === "rust") {
		name = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(text)?.[1];
	}
	if (!name) return null;
	if (language === "ts" && /^use[A-Z]/.test(name)) return { name, kind: "hook" };
	if (language === "ts" && /^[A-Z]/.test(name) && /\.(?:tsx|jsx)$/.test(path))
		return { name, kind: "component" };
	return { name, kind: "function" };
}

const CS_MODIFIERS =
	"(?:(?:public|internal|private|protected|static|virtual|override|required|readonly|new|abstract|sealed|async|extern|unsafe|partial|const|volatile|final|synchronized|default)\\s+)";
const CS_PROPERTY = new RegExp(
	`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODIFIERS}+[\\w<>\\[\\],.?()\\s]+?\\s+([A-Za-z_]\\w*)\\s*(?:\\{\\s*(?:get|set|init|private|protected|internal)|=>)`,
);
const CS_METHOD = new RegExp(
	`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODIFIERS}+(?:[\\w<>\\[\\],.?()]+\\s+)?([A-Za-z_]\\w*)\\s*(?:<[^>()]*>)?\\s*\\(`,
);
const CS_FIELD = new RegExp(
	`^\\s*(?:\\[[^\\]]*\\]\\s*)*${CS_MODIFIERS}+[\\w<>\\[\\],.?]+\\s+([A-Za-z_]\\w*)\\s*(?:=[^>]|;)`,
);
const KOTLIN_PROPERTY =
	/^\s*(?:(?:private|public|internal|protected|override|open|lateinit|const)\s+)*(?:val|var)\s+([A-Za-z_]\w*)/;
const JAVA_FIELD =
	/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|public|protected|static|final|transient)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:=|;)/;

const TS_METHOD =
	/^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::[^{=]+)?\s*\{?\s*$/;
const TS_PROPERTY =
	/^\s*(?:(?:public|private|protected|static|readonly|declare|override)\s+)*(?:#)?([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*[^;,]+[;,]?\s*$/;
const TS_CLASS_FIELD =
	/^\s*(?:(?:public|private|protected|static|readonly|override)\s+)+(?:#)?([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=]+)?=\s*/;
const TS_ENUM_VALUE = /^\s*([A-Za-z_$][\w$]*)\s*(?:=\s*[^,]+)?,?\s*$/;

const RESERVED = new Set([
	"if",
	"for",
	"foreach",
	"while",
	"switch",
	"catch",
	"return",
	"using",
	"lock",
	"new",
	"throw",
	"await",
	"else",
	"do",
	"try",
	"function",
	"constructor",
	"super",
	"this",
	"typeof",
	"sizeof",
	"nameof",
	"base",
	"get",
	"set",
	"init",
	"value",
	"default",
	"case",
	"with",
	"when",
]);

function parseMember(
	text: string,
	language: Language,
	owner: TypeDecl | null,
): { name: string; kind: MemberKind } | null {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#"))
		return null;
	const accept = (name: string | undefined, kind: MemberKind) =>
		name && !RESERVED.has(name) ? { name, kind } : null;

	if (language === "csharp" || language === "jvm") {
		const property = CS_PROPERTY.exec(text)?.[1];
		if (property) return accept(property, "property");
		// `val`/`var` sans « ; » final : Kotlin. Le `var user = …;` de C# est une
		// variable locale, pas une propriété.
		const kotlin = /;\s*$/.test(text) ? undefined : KOTLIN_PROPERTY.exec(text)?.[1];
		if (kotlin) return accept(kotlin, "property");
		const method = CS_METHOD.exec(text)?.[1];
		if (method)
			return accept(method, owner && method === owner.name ? "constructor" : "method");
		const field = CS_FIELD.exec(text)?.[1] ?? JAVA_FIELD.exec(text)?.[1];
		if (field) return accept(field, "field");
		if (owner?.kind === "enum") {
			const value = /^\s*([A-Z]\w*)\s*(?:=\s*[^,]+)?,?\s*$/.exec(text)?.[1];
			if (value) return accept(value, "value");
		}
		// Un membre d'interface ne porte pas de modificateur : `Task Save(User u);`.
		if (owner?.kind === "interface") {
			const signature =
				/^\s*(?:\[[^\]]*\]\s*)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:\{\s*(?:get|set|init)|(?:<[^>()]*>)?\s*\()/.exec(
					text,
				);
			if (signature)
				return accept(signature[1], /\{/.test(signature[0]) ? "property" : "method");
		}
		return null;
	}
	if (language === "ts") {
		if (!owner) return null;
		if (owner.kind === "enum") {
			const value = TS_ENUM_VALUE.exec(text)?.[1];
			return value ? accept(value, "value") : null;
		}
		if (owner.kind === "class") {
			const field = TS_CLASS_FIELD.exec(text)?.[1];
			if (field) return accept(field, "property");
			const method = TS_METHOD.exec(text)?.[1];
			if (method)
				return method === "constructor"
					? { name: "constructor", kind: "constructor" }
					: accept(method, "method");
			// Un champ de classe se termine par « ; » ; une clé d'objet littéral
			// dans le corps d'une méthode, par « , ».
			const field2 = /;\s*$/.test(text) ? TS_PROPERTY.exec(text)?.[1] : undefined;
			return field2 ? accept(field2, "property") : null;
		}
		if (owner.kind !== "interface") return null;
		const property = TS_PROPERTY.exec(text)?.[1];
		return property ? accept(property, "property") : null;
	}
	if (language === "python") {
		if (!owner) return null;
		const method = /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(text)?.[1];
		if (method)
			return method === "__init__"
				? { name: "__init__", kind: "constructor" }
				: accept(method, "method");
		const attribute = /^\s{4}([A-Za-z_]\w*)\s*:\s*[\w[\], .|"']+(?:=.*)?$/.exec(text)?.[1];
		if (attribute) return accept(attribute, "property");
		const selfField = /^\s+self\.([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(text)?.[1];
		if (selfField) return accept(selfField, "field");
		return null;
	}
	if (language === "go") {
		if (owner?.kind === "struct") {
			const field = /^\s+([A-Z]\w*)\s+[\w[\]*.{}]+/.exec(text)?.[1];
			if (field) return accept(field, "field");
		}
		return null;
	}
	if (language === "rust") {
		const method = /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(text)?.[1];
		if (method) return accept(method, "method");
		if (owner?.kind === "struct") {
			const field = /^\s+(?:pub\s+)?([a-z_]\w*)\s*:\s*[^,]+,?\s*$/.exec(text)?.[1];
			if (field) return accept(field, "field");
		}
		return null;
	}
	return null;
}

/** Méthode Go déclarée hors de son type : `func (u *User) Save()`. */
function goReceiver(text: string): { owner: string; name: string } | null {
	const m = /^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/.exec(
		text,
	);
	return m ? { owner: m[1] ?? "", name: m[2] ?? "" } : null;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

interface Draft {
	node: ChangeNode;
	decl: TypeDecl | null;
	/** Où la déclaration a été vue : des deux côtés, elle a été modifiée. */
	declSides: Set<LineSide>;
	/** Les lignes que ce nœud *porte* après la tâche : ajoutées et contexte. */
	text: string[];
	/** Les membres vus sur chaque côté, pour distinguer ajout, retrait, modif. */
	memberSides: Map<string, { kind: MemberKind; sides: Set<LineSide>; positional?: boolean }>;
	/** Membres dont le corps a changé sans que leur signature change. */
	touchedMembers: Map<string, MemberKind>;
	changedLines: number;
}

function nodeId(file: string, name: string): string {
	return `${file}#${name}`;
}

/**
 * Le graphe des modifications d'une tâche.
 *
 * Chaque type (classe, interface, record, composant…) que le patch déclare ou
 * touche devient un nœud ; un fichier qui n'en révèle aucun en devient un. Une
 * arête relie deux nœuds quand les lignes que la tâche laisse dans l'un citent
 * le nom de l'autre — la ligne est gardée comme preuve.
 */
export function buildChangeGraph(
	files: readonly ChangeGraphFile[],
	subtasks: readonly ChangeGraphSubtask[] = [],
	options: BuildChangeGraphOptions = {},
): ChangeGraph {
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const skippedFiles: string[] = [];
	const drafts: Draft[] = [];

	const subtasksByFile = new Map<string, string[]>();
	for (const subtask of subtasks) {
		for (const file of subtask.files ?? []) {
			const key = normalisePath(file);
			const list = subtasksByFile.get(key) ?? [];
			if (!list.includes(subtask.id)) list.push(subtask.id);
			subtasksByFile.set(key, list);
		}
	}
	const subtasksFor = (path: string): string[] => {
		const target = normalisePath(path);
		const direct = subtasksByFile.get(target);
		if (direct) return [...direct];
		// Un plan écrit ses chemins relativement à ce qu'il pensait être la
		// racine : `Domain/UserProfile.cs` pour `src/App.Domain/…`. Le suffixe
		// suffit, pourvu qu'il couvre un nom de fichier entier.
		const found: string[] = [];
		for (const [file, ids] of subtasksByFile) {
			if (target.endsWith(`/${file}`) || file.endsWith(`/${target}`)) {
				for (const id of ids) if (!found.includes(id)) found.push(id);
			}
		}
		return found;
	};

	for (const file of files) {
		const path = normalisePath(file.path);
		if (!path) continue;
		if (GENERATED_FILE.test(path)) {
			skippedFiles.push(path);
			continue;
		}
		drafts.push(...draftsForFile({ ...file, path }, subtasksFor(path)));
	}

	for (const draft of drafts) finaliseDraft(draft);

	// Au-delà du plafond, on garde ce qui porte le plus de changement : un
	// graphe de trois cents nœuds est une liste de fichiers dessinée.
	let kept = drafts;
	const truncatedFiles: string[] = [];
	if (drafts.length > maxNodes) {
		kept = [...drafts]
			.sort((a, b) => weight(b) - weight(a))
			.slice(0, maxNodes);
		const keptIds = new Set(kept.map((d) => d.node.id));
		for (const draft of drafts) {
			if (!keptIds.has(draft.node.id) && !truncatedFiles.includes(draft.node.file))
				truncatedFiles.push(draft.node.file);
		}
		kept = drafts.filter((d) => keptIds.has(d.node.id));
	}

	const edges = buildEdges(kept);
	const nodes = kept.map((d) => d.node);
	nodes.sort(
		(a, b) =>
			CHANGE_LAYERS.indexOf(a.layer) - CHANGE_LAYERS.indexOf(b.layer) ||
			a.file.localeCompare(b.file) ||
			a.name.localeCompare(b.name),
	);
	const layers = CHANGE_LAYERS.filter((layer) => nodes.some((n) => n.layer === layer));
	return { nodes, edges, layers, skippedFiles, truncatedFiles };
}

function normalisePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function weight(draft: Draft): number {
	return (
		draft.node.members.length * 10 +
		draft.node.additions +
		draft.node.deletions +
		(draft.node.kind === "file" ? 0 : 5)
	);
}

function fileStatus(file: ChangeGraphFile): ChangeStatus {
	if (file.status === "added") return "added";
	if (file.status === "deleted") return "deleted";
	return "modified";
}

function draftsForFile(file: ChangeGraphFile, subtaskIds: string[]): Draft[] {
	const language = languageOf(file.path);
	const lines = parsePatch(file.patch);
	const layer = layerOf(file.path);
	const byName = new Map<string, Draft>();
	const order: Draft[] = [];

	const make = (name: string, kind: SymbolKind, decl: TypeDecl | null): Draft => {
		const existing = byName.get(name);
		if (existing) {
			if (decl && !existing.decl) {
				existing.decl = decl;
				existing.node.kind = decl.kind;
			}
			return existing;
		}
		const draft: Draft = {
			node: {
				id: nodeId(file.path, name),
				name,
				kind,
				role:
					kind === "file" || kind === "module"
						? roleOf(stem(file.path), file.path) ?? fileRole(file.path, layer)
						: roleOf(name, file.path),
				layer,
				status: fileStatus(file),
				file: file.path,
				additions: 0,
				deletions: 0,
				members: [],
				subtaskIds,
			},
			decl,
			declSides: new Set(),
			text: [],
			memberSides: new Map(),
			touchedMembers: new Map(),
			changedLines: 0,
		};
		byName.set(name, draft);
		order.push(draft);
		return draft;
	};

	// Le nœud qui reçoit ce qui n'appartient à aucun type : le module (fichier
	// de code) ou le fichier lui-même. Créé à la demande seulement.
	const fileNodeName = basename(file.path);
	const fileKind: SymbolKind = language === "other" ? "file" : "module";
	const fallback = (): Draft => {
		// En C#, Java, Kotlin, le fichier porte le nom de son type : un bloc qui
		// tombe au milieu de `UserProfile.cs` est dans `UserProfile`.
		if (language === "csharp" || language === "jvm") {
			const name = stem(file.path);
			if (/^[A-Za-z_]\w*$/.test(name)) return make(name, "class", null);
		}
		return make(fileNodeName, fileKind, null);
	};

	let current: Draft | null = null;
	let currentMember: { name: string; kind: MemberKind } | null = null;

	for (const line of lines) {
		if (line.hunkStart) {
			current = null;
			currentMember = null;
			const fromHeader = parseTypeDecl(line.hunkContext, language);
			if (fromHeader?.name) {
				current = make(fromHeader.name, fromHeader.kind, fromHeader);
				// L'en-tête porte la déclaration — et donc ses bases : c'est là que se
				// lit `UserRepository : IUserRepository` quand seul le corps a changé.
				if (!current.text.includes(line.hunkContext)) current.text.push(line.hunkContext);
			} else if (language === "go") {
				const receiver = goReceiver(line.hunkContext);
				if (receiver) {
					current = make(receiver.owner, "struct", null);
					currentMember = { name: receiver.name, kind: "method" };
				}
			}
			if (!current && !currentMember) {
				const fn = parseTopLevelFunction(line.hunkContext, language, file.path);
				if (fn && (fn.kind === "component" || fn.kind === "hook")) {
					current = make(fn.name, fn.kind, null);
				} else if (fn) {
					current = make(fileNodeName, fileKind, null);
					currentMember = { name: fn.name, kind: "function" };
				}
			}
			if (!current && (language === "csharp" || language === "jvm")) {
				const member = parseMember(line.hunkContext, language, null);
				if (member) {
					current = fallback();
					currentMember = member;
				}
			}
		}

		const decl = parseTypeDecl(line.text, language);
		if (decl?.name) {
			current = make(decl.name, decl.kind, decl);
			current.declSides.add(line.side);
			if (line.side !== "-") current.text.push(line.text);
			if (line.side !== " ") current.changedLines++;
			if (decl.positional) {
				for (const param of decl.positional) {
					recordMember(current, param.name, "property", line.side, true);
				}
			}
			currentMember = null;
			continue;
		}

		let owner: Draft | null = current;
		let member: { name: string; kind: MemberKind } | null = null;

		if (language === "go") {
			const receiver = goReceiver(line.text);
			if (receiver) {
				owner = make(receiver.owner, "struct", null);
				current = owner;
				member = { name: receiver.name, kind: "method" };
			}
		}

		// Une fonction de haut niveau (sans indentation) sort du type courant.
		const topLevel = /^\S/.test(line.text)
			? parseTopLevelFunction(line.text, language, file.path)
			: null;
		if (!member && topLevel) {
			if (topLevel.kind === "component" || topLevel.kind === "hook") {
				owner = make(topLevel.name, topLevel.kind, null);
				owner.declSides.add(line.side);
				current = owner;
				if (line.side !== "-") owner.text.push(line.text);
				if (line.side !== " ") owner.changedLines++;
				currentMember = null;
				continue;
			}
			owner = make(fileNodeName, fileKind, null);
			current = null;
			member = { name: topLevel.name, kind: "function" };
		}

		if (!member) member = parseMember(line.text, language, owner?.decl ?? null);

		// En Python, une ligne revenue en colonne 0 a quitté la classe.
		if (language === "python" && owner && /^\S/.test(line.text) && !member) {
			owner = null;
			current = null;
		}

		if (!owner) {
			if (line.side === " " && !member) continue;
			owner = fallback();
		}

		if (line.side !== "-") owner.text.push(line.text);
		if (member) {
			recordMember(owner, member.name, member.kind, line.side);
			currentMember = member;
			if (line.side !== " ") owner.changedLines++;
			continue;
		}
		if (line.side === " ") continue;
		owner.changedLines++;
		if (currentMember) owner.touchedMembers.set(currentMember.name, currentMember.kind);
	}

	// Additions et suppressions : celles de `getWorktreeDiff` pour le fichier,
	// réparties au prorata des lignes que chaque nœud porte.
	const additions = file.additions ?? lines.filter((l) => l.side === "+").length;
	const deletions = file.deletions ?? lines.filter((l) => l.side === "-").length;
	if (order.length === 0) {
		const draft = make(
			language === "csharp" || language === "jvm" ? stem(file.path) : fileNodeName,
			language === "csharp" || language === "jvm" ? "class" : fileKind,
			null,
		);
		draft.node.additions = additions;
		draft.node.deletions = deletions;
		return order;
	}
	const total = order.reduce((sum, d) => sum + d.changedLines, 0) || order.length;
	for (const draft of order) {
		const share = (draft.changedLines || (total === order.length ? 1 : 0)) / total;
		draft.node.additions = Math.round(additions * share);
		draft.node.deletions = Math.round(deletions * share);
	}
	// Un nœud qui n'a été vu qu'en contexte n'a pas été modifié par la tâche.
	return order.filter((d) => d.changedLines > 0 || order.length === 1);
}

function fileRole(path: string, layer: ChangeLayer): SymbolRole | undefined {
	if (layer === "config") return "config";
	if (layer === "docs") return "docs";
	if (layer === "tests") return "test";
	return roleOf(stem(path), path);
}

function recordMember(
	draft: Draft,
	name: string,
	kind: MemberKind,
	side: LineSide,
	positional = false,
) {
	const entry = draft.memberSides.get(name) ?? {
		kind,
		sides: new Set<LineSide>(),
		positional,
	};
	entry.sides.add(side);
	draft.memberSides.set(name, entry);
}

function finaliseDraft(draft: Draft) {
	const { node } = draft;
	if (node.status === "modified" && draft.decl) {
		if (draft.declSides.has("+") && !draft.declSides.has("-") && !draft.declSides.has(" "))
			node.status = "added";
		else if (draft.declSides.has("-") && !draft.declSides.has("+") && !draft.declSides.has(" "))
			node.status = "deleted";
	}
	if (node.status === "modified" && (node.kind === "component" || node.kind === "hook")) {
		if (draft.declSides.has("+") && !draft.declSides.has("-") && !draft.declSides.has(" "))
			node.status = "added";
	}

	const members: MemberChange[] = [];
	for (const [name, { kind, sides, positional }] of draft.memberSides) {
		const added = sides.has("+");
		const removed = sides.has("-");
		if (node.status === "deleted") continue;
		if (added && !removed) {
			members.push({ name, kind, change: "added" });
		} else if (removed && !added) {
			members.push({ name, kind, change: "deleted" });
		} else if (added && removed && !positional) {
			// Un paramètre de record présent des deux côtés est resté tel quel :
			// c'est la ligne de déclaration qui a changé, pas lui.
			members.push({ name, kind, change: "modified" });
		}
	}
	for (const [name, kind] of draft.touchedMembers) {
		if (!members.some((m) => m.name === name)) members.push({ name, kind, change: "modified" });
	}
	node.members = members;
}

/** Les liens entre les nœuds, lus dans ce que la tâche a laissé dans le code. */
function buildEdges(drafts: readonly Draft[]): ChangeEdge[] {
	const edges: ChangeEdge[] = [];
	const referable = drafts.filter(
		(d) => d.node.kind !== "file" && d.node.kind !== "module" && d.node.name.length >= 3,
	);
	const patterns = new Map(
		referable.map((d) => [d.node.id, new RegExp(`\\b${escapeRegExp(d.node.name)}\\b`)]),
	);
	const addedMembers = (d: Draft) =>
		new Map(
			d.node.members
				.filter((m) => m.change !== "deleted" && m.kind !== "constructor")
				.map((m) => [m.name.toLowerCase(), m.name]),
		);

	for (const from of drafts) {
		if (from.node.status === "deleted") continue;
		for (const to of referable) {
			if (to === from) continue;
			const pattern = patterns.get(to.node.id);
			if (!pattern) continue;

			// Une ligne d'usage d'abord ; un import seul prouve le lien aussi,
			// mais dit moins ce qu'il fait.
			const evidence =
				from.text.find(
					(line) =>
						pattern.test(line) &&
						!/^\s*(?:using|import|from|package)\b/.test(line),
				) ?? from.text.find((line) => pattern.test(line));
			const fromShared = addedMembers(from);
			const shared = [...addedMembers(to).entries()]
				.filter(([key]) => fromShared.has(key))
				.map(([, name]) => name);
			// Un DTO nommé d'après l'entité, qui reçoit les mêmes propriétés : le
			// lien existe même quand le mapping vit dans un troisième fichier.
			const namesake =
				shared.length > 0 &&
				from.node.name !== to.node.name &&
				// `UserProfileDto` prolonge `UserProfile` ; `IUserRepository` ne
				// prolonge pas `UserRepository`, il l'abstrait.
				from.node.name.startsWith(to.node.name);

			if (!evidence && !namesake) continue;

			const relation = relationFor(from, to, evidence);
			edges.push({
				id: `${from.node.id}->${to.node.id}`,
				source: from.node.id,
				target: to.node.id,
				relation,
				evidence: evidence?.trim().slice(0, 200),
				sharedMembers: shared,
			});
		}
	}
	return edges;
}

function relationFor(from: Draft, to: Draft, evidence: string | undefined): EdgeRelation {
	const bases = from.decl?.bases ?? "";
	// Les parenthèses ne listent des bases qu'en Python ; ailleurs ce sont les
	// paramètres d'un record positionnel.
	const opener = from.node.file.endsWith(".py") ? "\\(" : "(?::|extends|implements)";
	const inBases =
		bases !== "" &&
		new RegExp(`${opener}[^{]*\\b${escapeRegExp(to.node.name)}\\b`).test(bases);
	if (inBases && from.node.layer !== "tests") {
		return to.node.kind === "interface" ? "implements" : "inherits";
	}
	if (from.node.layer === "tests") return "tests";
	if (
		from.node.role === "handler" &&
		(to.node.role === "command" || to.node.role === "query")
	)
		return "handles";
	const mapperRoles: Array<SymbolRole | undefined> = [
		"dto",
		"request",
		"response",
		"viewModel",
		"mapper",
		"command",
		"query",
	];
	if (mapperRoles.includes(from.node.role) && to.node.role !== from.node.role) return "maps";
	if (evidence && /\bnew\s+\w+|\.Map<|\bmap\w*\(/i.test(evidence) && from.node.role === "mapper")
		return "maps";
	return "uses";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

/** La signature de `t` dont ce module a besoin — et rien de plus. */
export type ChangeGraphTranslate = (
	key: string,
	options?: Record<string, unknown>,
) => string;

const NS = "tasks:changeGraph";

function capitalise(value: string): string {
	return value ? value[0]?.toUpperCase() + value.slice(1) : value;
}

/** « la classe UserProfile », « le DTO UserProfileDto », « le fichier appsettings.json ». */
export function describeSubject(node: ChangeNode, t: ChangeGraphTranslate): string {
	return t(`${NS}.nouns.${nounKey(node)}`, { name: node.name });
}

/** La même chose au génitif : « de la classe UserProfile », « du DTO UserProfileDto ». */
export function describeSubjectOf(node: ChangeNode, t: ChangeGraphTranslate): string {
	return t(`${NS}.nounsOf.${nounKey(node)}`, { name: node.name });
}

function nounKey(node: ChangeNode): string {
	// `IUserRepository` est d'abord une interface : le suffixe dit ce qu'elle
	// abstrait, pas ce qu'elle est.
	if (node.kind === "interface" && node.role !== "test") return "interface";
	if (node.role) {
		if (node.role === "test" && node.kind !== "file" && node.kind !== "module") return "testClass";
		return node.role;
	}
	return node.kind;
}

function describeMember(member: MemberChange, t: ChangeGraphTranslate): string {
	return t(`${NS}.members.${member.kind}`, { name: member.name });
}

function joinList(items: string[], t: ChangeGraphTranslate): string {
	if (items.length <= 1) return items[0] ?? "";
	const head = items.slice(0, -1).join(", ");
	return t(`${NS}.join`, { head, last: items[items.length - 1] });
}

/** Au-delà, une énumération ne se lit plus : on compte. */
const MAX_LISTED_MEMBERS = 4;

/**
 * « la propriété BirthDate », « les propriétés Id et BirthDate et la méthode
 * Handle() » : les membres d'une même sorte sont nommés ensemble.
 */
function listMembers(members: MemberChange[], t: ChangeGraphTranslate): string {
	const shown = members.slice(0, MAX_LISTED_MEMBERS);
	const groups = new Map<MemberKind, MemberChange[]>();
	for (const member of shown) {
		const group = groups.get(member.kind) ?? [];
		group.push(member);
		groups.set(member.kind, group);
	}
	const parts: string[] = [];
	for (const [kind, group] of groups) {
		if (group.length === 1 || kind === "constructor") {
			parts.push(describeMember(group[0] as MemberChange, t));
			continue;
		}
		const callable = kind === "method" || kind === "function";
		const names = group.map((m) => (callable ? `${m.name}()` : m.name));
		parts.push(t(`${NS}.members.${kind}Plural`, { names: joinList(names, t) }));
	}
	const rest = members.length - shown.length;
	if (rest > 0) parts.push(t(`${NS}.members.more`, { count: rest }));
	return joinList(parts, t);
}

/**
 * La phrase d'un nœud, à la première personne, comme l'agent la dirait :
 * « J'ai modifié la classe UserProfile dans la couche Domain et j'y ai ajouté
 * la propriété BirthDate. »
 */
export function describeNode(node: ChangeNode, t: ChangeGraphTranslate): string {
	const subject = describeSubject(node, t);
	const where = t(`${NS}.layers.${node.layer}.in`);
	const base = t(`${NS}.sentences.${node.status}`, { subject, where });

	if (node.status === "deleted") return `${base}.`;

	const added = node.members.filter((m) => m.change === "added");
	const removed = node.members.filter((m) => m.change === "deleted");
	const modified = node.members.filter((m) => m.change === "modified");

	if (node.status === "added") {
		return added.length > 0
			? `${t(`${NS}.sentences.createdWith`, { base, items: listMembers(added, t) })}.`
			: `${base}.`;
	}

	const clauses: string[] = [];
	if (added.length) clauses.push(t(`${NS}.clauses.added`, { items: listMembers(added, t) }));
	if (removed.length)
		clauses.push(t(`${NS}.clauses.removed`, { items: listMembers(removed, t) }));
	if (modified.length)
		clauses.push(t(`${NS}.clauses.modified`, { items: listMembers(modified, t) }));

	if (clauses.length === 0) {
		return `${t(`${NS}.sentences.modifiedLines`, {
			base,
			additions: node.additions,
			deletions: node.deletions,
		})}.`;
	}
	return `${t(`${NS}.sentences.modifiedWith`, { base, changes: joinList(clauses, t) })}.`;
}

/** La phrase d'une arête : ce que le lien veut dire, dans le sens où il va. */
export function describeEdge(
	edge: ChangeEdge,
	nodes: ReadonlyMap<string, ChangeNode>,
	t: ChangeGraphTranslate,
): string {
	const from = nodes.get(edge.source);
	const to = nodes.get(edge.target);
	if (!from || !to) return "";
	const values = {
		from: describeSubject(from, t),
		to: describeSubject(to, t),
		toOf: describeSubjectOf(to, t),
		fromLayer: t(`${NS}.layers.${from.layer}.name`),
		toLayer: t(`${NS}.layers.${to.layer}.name`),
	};
	const crossLayer =
		from.layer !== to.layer &&
		!["other", "config", "docs", "tests"].includes(from.layer) &&
		!["other", "config", "docs", "tests"].includes(to.layer);
	const key =
		(edge.relation === "uses" || edge.relation === "maps") && crossLayer
			? `${edge.relation}Cross`
			: edge.relation;
	let sentence = capitalise(t(`${NS}.edges.${key}`, values));
	if (edge.sharedMembers.length > 0) {
		sentence += ` ${t(`${NS}.edges.shared`, {
			items: joinList(
				edge.sharedMembers.slice(0, MAX_LISTED_MEMBERS),
				t,
			),
		})}`;
	}
	return sentence;
}

/**
 * Le récit de la tâche : les nœuds dans l'ordre où la fonctionnalité se
 * construit, chacun suivi des liens qui en partent.
 */
export function describeGraph(
	graph: ChangeGraph,
	t: ChangeGraphTranslate,
): Array<{ nodeId: string; text: string; edges: Array<{ edgeId: string; text: string }> }> {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	return graph.nodes.map((node) => ({
		nodeId: node.id,
		text: describeNode(node, t),
		edges: graph.edges
			.filter((e) => e.source === node.id)
			.map((e) => ({ edgeId: e.id, text: describeEdge(e, byId, t) })),
	}));
}

// ---------------------------------------------------------------------------
// Graphify
// ---------------------------------------------------------------------------

export const CHANGE_GRAPH_ORIGIN = "workpilot-change-graph";

/**
 * Le graphe au format node-link que Graphify écrit dans `graph.json` : les
 * mêmes clés (`id`, `label`, `file_type`, `source_file`, `metadata` ;
 * `source`, `target`, `relation`), si bien que Graphify, son serveur MCP et le
 * skill `graph-first-recall` le lisent sans adaptation. `metadata.origin`
 * sépare nos nœuds de ceux qu'un build Graphify écrirait dans le même fichier.
 */
export function toGraphifyNodeLink(
	graph: ChangeGraph,
	context: { taskId?: string; specId?: string; describe?: ChangeGraphTranslate } = {},
): Record<string, unknown> {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	return {
		directed: true,
		multigraph: false,
		graph: {
			origin: CHANGE_GRAPH_ORIGIN,
			task: context.taskId,
			spec: context.specId,
			layers: graph.layers,
		},
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			label: node.name,
			file_type: node.kind === "file" ? "document" : "code",
			source_file: node.file,
			metadata: {
				origin: CHANGE_GRAPH_ORIGIN,
				kind: node.kind,
				role: node.role,
				layer: node.layer,
				status: node.status,
				additions: node.additions,
				deletions: node.deletions,
				members: node.members,
				subtasks: node.subtaskIds,
				...(context.describe ? { summary: describeNode(node, context.describe) } : {}),
			},
		})),
		links: graph.edges.map((edge) => ({
			source: edge.source,
			target: edge.target,
			relation: edge.relation,
			evidence: edge.evidence,
			shared_members: edge.sharedMembers,
			...(context.describe
				? { summary: describeEdge(edge, byId, context.describe) }
				: {}),
		})),
	};
}
