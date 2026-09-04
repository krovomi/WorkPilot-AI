/**
 * Shared shapes for the API Explorer source scan.
 *
 * A detector turns source files into `DetectedRoute`s; `buildOpenApiSpec`
 * turns those into an OpenAPI document the renderer already knows how to
 * drive (forms, JSON body placeholders, `$ref` resolution).
 */

/** A JSON Schema fragment, kept structural so detectors can emit `$ref`s. */
export interface JsonSchema {
	type?: string;
	format?: string;
	description?: string;
	nullable?: boolean;
	enum?: unknown[];
	items?: JsonSchema;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	$ref?: string;
	example?: unknown;
}

export interface RouteParameter {
	name: string;
	in: "path" | "query" | "header";
	required: boolean;
	schema: JsonSchema;
	description?: string;
}

export interface RouteRequestBody {
	required: boolean;
	contentType: string;
	schema: JsonSchema;
}

export interface RouteResponse {
	description: string;
	schema?: JsonSchema;
}

export interface DetectedRoute {
	path: string;
	methods: string[];
	summary?: string;
	description?: string;
	tag: string;
	file: string;
	framework: string;
	requiresAuth: boolean;
	deprecated?: boolean;
	/**
	 * Parameters read from the source. When absent, the spec builder falls back
	 * to deriving path parameters from the route template alone.
	 */
	parameters?: RouteParameter[];
	requestBody?: RouteRequestBody;
	responses?: Record<string, RouteResponse>;
	/**
	 * The project the route belongs to — a .NET assembly name, say. Set when a
	 * scan root holds several applications, so `Rag.Api` and `Rag.Admin` stay
	 * told apart in the endpoint list.
	 */
	project?: string;
}

export interface ScanResult {
	routes: DetectedRoute[];
	/** How many source files the detector actually read. */
	filesScanned: number;
	/** Component schemas referenced by the routes, keyed by schema name. */
	schemas: Record<string, JsonSchema>;
	/**
	 * The applications found under the scan root, when it holds several — the
	 * `.sln` case. Names only: what the user needs to see is that pointing at
	 * the solution folder found `Rag.Api`, not the folder itself.
	 */
	apiProjects?: string[];
}
