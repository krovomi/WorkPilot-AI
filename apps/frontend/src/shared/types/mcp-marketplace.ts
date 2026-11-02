/**
 * MCP Marketplace Types
 *
 * Types for the MCP Marketplace feature — the universal integration ecosystem.
 * Supports catalog browsing, one-click install, and no-code MCP server building.
 */

/** MCP server categories for marketplace organization */
export type McpCategory =
	| "communication"
	| "project-management"
	| "design"
	| "monitoring"
	| "version-control"
	| "documentation"
	| "database"
	| "cloud"
	| "testing"
	| "web"
	| "security"
	| "analytics"
	| "ai"
	| "custom";

/** MCP server transport type */
export type McpTransportType = "stdio" | "http" | "sse";

/** A catalog text in each language the app ships. */
export interface LocalizedText {
	en: string;
	fr: string;
}

/**
 * A value the user types when installing a catalog server.
 *
 * `${name}` in the entry's args, url or headers is replaced by the value; a
 * variable no placeholder names goes to the server's environment (stdio only).
 */
export interface McpCatalogVar {
	/** Variable name (an environment variable name, e.g. NOTION_TOKEN) */
	name: string;
	/** Short label (product terms, not translated) */
	label: string;
	/** Help text */
	description: LocalizedText;
	/** Must be filled before installing */
	required: boolean;
	/** Masked in the form */
	secret: boolean;
	/** Placeholder value */
	placeholder?: string;
	/** Page where the user gets the value */
	helpUrl?: string;
}

/** Info about a tool provided by an MCP server */
export interface McpToolInfo {
	/** Tool name */
	name: string;
	/** Tool description */
	description: string;
}

/**
 * A server entry of the MCP Marketplace catalog
 * (`shared/mcp-catalog/servers.json`). Installing it adds a
 * `CustomMcpServer` to the project, which agents then start.
 */
export interface McpMarketplaceServer {
	/** Unique server identifier, also the project's custom server id */
	id: string;
	/** Display name */
	name: string;
	tagline: LocalizedText;
	description: LocalizedText;
	/** Publisher; "(community)" when the vendor does not maintain it */
	author: string;
	/** Maintained by the vendor of the product it connects to */
	official: boolean;
	category: McpCategory;
	/** Brand color (hex) */
	color: string;
	/** npm or PyPI package, or the URL of a remote server */
	package: string;
	transport: McpTransportType;
	/** Launcher for stdio (npx or uvx) */
	command?: string;
	/** Launcher args, may hold `${VAR}` placeholders */
	args?: string[];
	/** Remote server URL, may hold `${VAR}` placeholders */
	url?: string;
	/** Remote server headers, may hold `${VAR}` placeholders */
	headers?: Record<string, string>;
	/** Fixed environment of a stdio server */
	env?: Record<string, string>;
	/** Values asked at install */
	vars: McpCatalogVar[];
	/** Tool the machine needs besides Node.js: uv (uvx) or the Azure CLI */
	requires?: "uv" | "az";
	tools: McpToolInfo[];
	tags: string[];
	homepage: string;
}

/** Environment variable of a builder project */
export interface McpEnvVar {
	/** Variable name (e.g., SLACK_BOT_TOKEN) */
	name: string;
	/** Human-readable label */
	label: string;
	/** Description / help text */
	description: string;
	/** Is this variable required? */
	required: boolean;
	/** Placeholder value */
	placeholder?: string;
	/** Is this a secret (password-masked)? */
	secret: boolean;
	/** Link to obtain the value (e.g., API key creation page) */
	helpUrl?: string;
}

// ============================================
// MCP Builder Types (No-Code Server Creation)
// ============================================

/** A tool definition in the MCP Builder */
export interface McpBuilderTool {
	/** Unique tool ID (generated) */
	id: string;
	/** Tool name (snake_case) */
	name: string;
	/** Tool description */
	description: string;
	/** Input parameters schema */
	parameters: McpBuilderParam[];
	/** The action to perform */
	action: McpBuilderAction;
}

/** A parameter for an MCP builder tool */
export interface McpBuilderParam {
	/** Parameter name */
	name: string;
	/** Parameter type */
	type: "string" | "number" | "boolean" | "array" | "object";
	/** Description */
	description: string;
	/** Is required? */
	required: boolean;
	/** Default value */
	defaultValue?: string;
}

/** Action type for an MCP builder tool */
export type McpBuilderActionType = "http_request" | "transform" | "chain";

/** Action config for an MCP builder tool */
export interface McpBuilderAction {
	/** Action type */
	type: McpBuilderActionType;
	/** HTTP config (for http_request) */
	http?: {
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		url: string;
		headers?: Record<string, string>;
		bodyTemplate?: string;
	};
	/** Transform config (for transform type) */
	transform?: {
		template: string;
	};
	/** Chain config (references other tool IDs) */
	chain?: {
		steps: string[];
	};
}

/** Full MCP Builder project (a custom server definition) */
export interface McpBuilderProject {
	/** Unique project ID */
	id: string;
	/** Server name */
	name: string;
	/** Server description */
	description: string;
	/** Icon (lucide key) */
	icon: string;
	/** Brand color */
	color: string;
	/** Base URL for HTTP actions */
	baseUrl?: string;
	/** Default headers for HTTP actions */
	defaultHeaders?: Record<string, string>;
	/** Environment variables */
	envVars: McpEnvVar[];
	/** Tools defined in this server */
	tools: McpBuilderTool[];
	/** Date created */
	createdAt: string;
	/** Date last modified */
	updatedAt: string;
}

// ============================================
// Marketplace Store Types
// ============================================

/** Filter options for the marketplace catalog */
export interface McpMarketplaceFilters {
	search: string;
	category: McpCategory | "all";
	sortBy: "featured" | "name";
	showInstalledOnly: boolean;
	showOfficialOnly: boolean;
}

/** Active tab in the marketplace */
export type McpMarketplaceTab = "catalog" | "installed" | "builder";

// ============================================
// Hugging Face Hub discovery (via the official HF MCP server)
// ============================================

/** Parameters for a live Hub model search. */
export interface HuggingFaceModelSearchParams {
	/** Free-text query (model name / keyword). */
	query?: string;
	/** Pipeline task tag, e.g. "text-generation" (default). Empty = any task. */
	task?: string;
	/** Library tag, e.g. "gguf", "transformers". */
	library?: string;
	/** Language code, e.g. "en", "fr". */
	language?: string;
	/** License id, e.g. "apache-2.0", "mit". */
	license?: string;
	/** Organization / user namespace to filter by, e.g. "meta-llama". */
	author?: string;
	/** Sort order. */
	sort?: "trending" | "downloads" | "likes" | "created" | "modified";
	/** Max results to return. */
	limit?: number;
	/** Optional HF read token (raises rate limits, unlocks gated repos). */
	token?: string;
}

/** A single model returned from the Hub. */
export interface HuggingFaceModelInfo {
	/** Repo id, e.g. "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF". */
	id: string;
	/** Lifetime downloads, when available. */
	downloads?: number;
	/** Likes, when available. */
	likes?: number;
	/** Pipeline tag, e.g. "text-generation". */
	pipelineTag?: string;
	/** Primary library, e.g. "gguf", "transformers", when available. */
	library?: string;
	/** Canonical Hub URL for the repo. */
	url: string;
}
