import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Minimal OpenAPI types ────────────────────────────────────────────────────

export interface OpenApiSchema {
	type?: string;
	format?: string;
	description?: string;
	example?: unknown;
	enum?: unknown[];
	properties?: Record<string, OpenApiSchema>;
	items?: OpenApiSchema;
	required?: string[];
	$ref?: string;
	allOf?: OpenApiSchema[];
	anyOf?: OpenApiSchema[];
	oneOf?: OpenApiSchema[];
	nullable?: boolean;
	default?: unknown;
	additionalProperties?: boolean | OpenApiSchema;
}

export interface OpenApiParameter {
	name: string;
	in: "query" | "path" | "header" | "cookie";
	required?: boolean;
	description?: string;
	schema?: OpenApiSchema;
	example?: unknown;
}

export interface OpenApiRequestBody {
	description?: string;
	required?: boolean;
	content: Record<string, { schema?: OpenApiSchema; example?: unknown }>;
}

export interface OpenApiResponse {
	description?: string;
	content?: Record<string, { schema?: OpenApiSchema; example?: unknown }>;
}

export interface OpenApiOperation {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	parameters?: OpenApiParameter[];
	requestBody?: OpenApiRequestBody;
	responses?: Record<string, OpenApiResponse>;
	deprecated?: boolean;
}

export interface OpenApiSpec {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, OpenApiOperation>>;
	tags?: Array<{ name: string; description?: string }>;
	components?: {
		schemas?: Record<string, OpenApiSchema>;
		parameters?: Record<string, OpenApiParameter>;
	};
	servers?: Array<{ url: string; description?: string }>;
}

// ── Environment ──────────────────────────────────────────────────────────────

export interface ApiEnvironment {
	id: string;
	name: string;
	baseUrl: string;
	headers: Record<string, string>;
	/** Bearer token — auto-injected as Authorization: Bearer <token> if set */
	token?: string;
	isDefault?: boolean;
}

// ── Endpoint key helper ──────────────────────────────────────────────────────

export function makeEndpointKey(method: string, path: string): string {
	return `${method.toUpperCase()}:${path}`;
}

// ── Request Auth ─────────────────────────────────────────────────────────────

export type AuthType =
	| "inherited"
	| "none"
	| "bearer"
	| "basic"
	| "apikey"
	| "oauth2";
export type OAuth2GrantType =
	| "client_credentials"
	| "authorization_code"
	| "password";

export interface RequestAuth {
	type: AuthType;
	bearer: string;
	username: string;
	password: string;
	keyName: string;
	keyValue: string;
	keyLocation: "header" | "query";
	// OAuth 2.0
	oauth2GrantType: OAuth2GrantType;
	oauth2TokenUrl: string;
	oauth2AuthUrl: string;
	oauth2ClientId: string;
	oauth2ClientSecret: string;
	oauth2Scope: string;
	oauth2AccessToken: string;
	oauth2HeaderPrefix: string;
}

export const DEFAULT_REQUEST_AUTH: RequestAuth = {
	type: "inherited",
	bearer: "",
	username: "",
	password: "",
	keyName: "X-API-Key",
	keyValue: "",
	keyLocation: "header",
	oauth2GrantType: "client_credentials",
	oauth2TokenUrl: "",
	oauth2AuthUrl: "",
	oauth2ClientId: "",
	oauth2ClientSecret: "",
	oauth2Scope: "",
	oauth2AccessToken: "",
	oauth2HeaderPrefix: "Bearer",
};

export interface ApiRequestDraft {
	pathParams: Record<string, string>;
	queryParams: Record<string, string>;
	headers: Record<string, string>;
	body: string;
	auth: RequestAuth;
}

const EMPTY_REQUEST_DRAFT: ApiRequestDraft = {
	pathParams: {},
	queryParams: {},
	headers: {},
	body: "",
	auth: { ...DEFAULT_REQUEST_AUTH },
};

function requestDraftKey(projectId: string, endpointKey: string): string {
	return `${projectId}::${endpointKey}`;
}

function withoutSecrets(auth: RequestAuth): RequestAuth {
	return {
		...auth,
		bearer: "",
		password: "",
		keyValue: "",
		oauth2ClientSecret: "",
		oauth2AccessToken: "",
	};
}

// ── Store ────────────────────────────────────────────────────────────────────

export type SpecSource = "url" | "file" | "scan" | null;

interface ApiExplorerState {
	activeProjectId: string | null;
	// Spec
	spec: OpenApiSpec | null;
	specUrl: string;
	specUrlsByProject: Record<string, string>;
	isLoadingSpec: boolean;
	specError: string | null;
	/**
	 * Where the current spec came from: 'url' = fetched from the running app,
	 * 'file' = an OpenAPI document committed to the repository, 'scan' =
	 * inferred from the source code.
	 */
	specSource: SpecSource;
	/** Project-relative path of the committed spec, when `specSource` is 'file'. */
	specFilePath: string | null;

	// Background project scan state (not persisted)
	isProjectScanning: boolean;
	projectScanError: string | null;
	/** ID of the project that was last scanned */
	scannedProjectId: string | null;
	/** Timestamp of last successful scan */
	lastProjectScanAt: number | null;

	// Environments (persisted)
	environments: ApiEnvironment[];
	activeEnvironmentId: string;

	// Navigation
	selectedEndpointKey: string | null;
	searchQuery: string;
	collapsedTags: string[];

	// Request builder state (per-session, not persisted)
	requestPathParams: Record<string, string>;
	requestQueryParams: Record<string, string>;
	requestHeaders: Record<string, string>;
	requestBody: string;
	requestAuth: RequestAuth;
	requestDrafts: Record<string, ApiRequestDraft>;
	selectedEndpointByProject: Record<string, string | null>;

	// Response state
	responseStatus: number | null;
	responseStatusText: string;
	responseHeaders: Record<string, string>;
	responseBody: string;
	responseTime: number | null;
	isSendingRequest: boolean;

	// Actions
	setSpec: (spec: OpenApiSpec | null) => void;
	setSpecUrl: (url: string) => void;
	setIsLoadingSpec: (loading: boolean) => void;
	setSpecError: (error: string | null) => void;
	setSpecSource: (source: SpecSource) => void;
	setSpecFilePath: (path: string | null) => void;
	setIsProjectScanning: (scanning: boolean) => void;
	setProjectScanError: (error: string | null) => void;
	setScannedProjectId: (projectId: string | null) => void;
	setLastProjectScanAt: (ts: number | null) => void;

	addEnvironment: (env: Omit<ApiEnvironment, "id">) => void;
	updateEnvironment: (
		id: string,
		updates: Partial<Omit<ApiEnvironment, "id">>,
	) => void;
	removeEnvironment: (id: string) => void;
	setActiveEnvironment: (id: string) => void;

	setSelectedEndpointKey: (key: string | null) => void;
	setActiveProjectContext: (projectId: string | null) => void;
	setSearchQuery: (query: string) => void;
	toggleTag: (tag: string) => void;

	setRequestPathParams: (params: Record<string, string>) => void;
	setRequestQueryParams: (params: Record<string, string>) => void;
	setRequestHeaders: (headers: Record<string, string>) => void;
	setRequestBody: (body: string) => void;
	setRequestAuth: (auth: Partial<RequestAuth>) => void;
	clearRequestState: () => void;

	setResponse: (payload: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		time: number;
	}) => void;
	clearResponse: () => void;
	setIsSendingRequest: (sending: boolean) => void;
}

function updateCurrentDraft(
	state: ApiExplorerState,
	updates: Partial<ApiRequestDraft>,
): Record<string, ApiRequestDraft> {
	if (!state.activeProjectId || !state.selectedEndpointKey) {
		return state.requestDrafts;
	}
	const key = requestDraftKey(
		state.activeProjectId,
		state.selectedEndpointKey,
	);
	const existing = state.requestDrafts[key] ?? EMPTY_REQUEST_DRAFT;
	return {
		...state.requestDrafts,
		[key]: {
			...existing,
			...updates,
			auth: updates.auth ?? existing.auth,
		},
	};
}

const DEFAULT_ENVIRONMENTS: ApiEnvironment[] = [
	{
		id: "local",
		name: "Local",
		baseUrl: "http://localhost:9000",
		headers: {},
		isDefault: true,
	},
];

export const useApiExplorerStore = create<ApiExplorerState>()(
	persist(
		(set) => ({
			activeProjectId: null,
			// Spec
			spec: null,
			specUrl: "",
			specUrlsByProject: {},
			isLoadingSpec: false,
			specError: null,
			specSource: null,
			specFilePath: null,

			// Project scan
			isProjectScanning: false,
			projectScanError: null,
			scannedProjectId: null,
			lastProjectScanAt: null,

			// Environments
			environments: DEFAULT_ENVIRONMENTS,
			activeEnvironmentId: "local",

			// Navigation
			selectedEndpointKey: null,
			searchQuery: "",
			collapsedTags: [],

			// Request
			requestPathParams: {},
			requestQueryParams: {},
			requestHeaders: {},
			requestBody: "",
			requestAuth: { ...DEFAULT_REQUEST_AUTH },
			requestDrafts: {},
			selectedEndpointByProject: {},

			// Response
			responseStatus: null,
			responseStatusText: "",
			responseHeaders: {},
			responseBody: "",
			responseTime: null,
			isSendingRequest: false,

			// Spec actions
			setSpec: (spec) => set({ spec }),
			setSpecUrl: (specUrl) =>
				set((state) => ({
					specUrl,
					specUrlsByProject: state.activeProjectId
						? { ...state.specUrlsByProject, [state.activeProjectId]: specUrl }
						: state.specUrlsByProject,
				})),
			setIsLoadingSpec: (isLoadingSpec) => set({ isLoadingSpec }),
			setSpecError: (specError) => set({ specError }),
			setSpecSource: (specSource) => set({ specSource }),
			setSpecFilePath: (specFilePath) => set({ specFilePath }),
			setIsProjectScanning: (isProjectScanning) => set({ isProjectScanning }),
			setProjectScanError: (projectScanError) => set({ projectScanError }),
			setScannedProjectId: (scannedProjectId) => set({ scannedProjectId }),
			setLastProjectScanAt: (lastProjectScanAt) => set({ lastProjectScanAt }),

			// Environment actions
			addEnvironment: (env) =>
				set((state) => ({
					environments: [
						...state.environments,
						{ ...env, id: `env-${Date.now()}` },
					],
				})),
			updateEnvironment: (id, updates) =>
				set((state) => ({
					environments: state.environments.map((e) =>
						e.id === id ? { ...e, ...updates } : e,
					),
				})),
			removeEnvironment: (id) =>
				set((state) => ({
					environments: state.environments.filter((e) => e.id !== id),
					activeEnvironmentId:
						state.activeEnvironmentId === id
							? (state.environments[0]?.id ?? "local")
							: state.activeEnvironmentId,
				})),
			setActiveEnvironment: (activeEnvironmentId) =>
				set({ activeEnvironmentId }),

			// Navigation actions
			setActiveProjectContext: (activeProjectId) =>
				set((state) => {
					const selectedEndpointKey = activeProjectId
						? (state.selectedEndpointByProject[activeProjectId] ?? null)
						: null;
					const draft =
						activeProjectId && selectedEndpointKey
							? state.requestDrafts[
									requestDraftKey(activeProjectId, selectedEndpointKey)
								]
							: undefined;
					return {
						activeProjectId,
						specUrl: activeProjectId
							? (state.specUrlsByProject[activeProjectId] ?? "")
							: "",
						selectedEndpointKey,
						requestPathParams: { ...(draft?.pathParams ?? {}) },
						requestQueryParams: { ...(draft?.queryParams ?? {}) },
						requestHeaders: { ...(draft?.headers ?? {}) },
						requestBody: draft?.body ?? "",
						requestAuth: { ...(draft?.auth ?? DEFAULT_REQUEST_AUTH) },
						responseStatus: null,
						responseBody: "",
						responseTime: null,
					};
				}),
			setSelectedEndpointKey: (selectedEndpointKey) =>
				set((state) => {
					const draft =
						state.activeProjectId && selectedEndpointKey
							? state.requestDrafts[
									requestDraftKey(state.activeProjectId, selectedEndpointKey)
								]
							: undefined;
					return {
						selectedEndpointKey,
						selectedEndpointByProject: state.activeProjectId
							? {
									...state.selectedEndpointByProject,
									[state.activeProjectId]: selectedEndpointKey,
								}
							: state.selectedEndpointByProject,
						requestPathParams: { ...(draft?.pathParams ?? {}) },
						requestQueryParams: { ...(draft?.queryParams ?? {}) },
						requestHeaders: { ...(draft?.headers ?? {}) },
						requestBody: draft?.body ?? "",
						requestAuth: { ...(draft?.auth ?? DEFAULT_REQUEST_AUTH) },
						responseStatus: null,
						responseBody: "",
						responseTime: null,
					};
				}),
			setSearchQuery: (searchQuery) => set({ searchQuery }),
			toggleTag: (tag) =>
				set((state) => ({
					collapsedTags: state.collapsedTags.includes(tag)
						? state.collapsedTags.filter((t) => t !== tag)
						: [...state.collapsedTags, tag],
				})),

			// Request actions
			setRequestPathParams: (requestPathParams) =>
				set((state) => ({
					requestPathParams,
					requestDrafts: updateCurrentDraft(state, {
						pathParams: requestPathParams,
					}),
				})),
			setRequestQueryParams: (requestQueryParams) =>
				set((state) => ({
					requestQueryParams,
					requestDrafts: updateCurrentDraft(state, {
						queryParams: requestQueryParams,
					}),
				})),
			setRequestHeaders: (requestHeaders) =>
				set((state) => ({
					requestHeaders,
					requestDrafts: updateCurrentDraft(state, {
						headers: requestHeaders,
					}),
				})),
			setRequestBody: (requestBody) =>
				set((state) => ({
					requestBody,
					requestDrafts: updateCurrentDraft(state, { body: requestBody }),
				})),
			setRequestAuth: (auth) =>
				set((state) => {
					const requestAuth = { ...state.requestAuth, ...auth };
					return {
						requestAuth,
						requestDrafts: updateCurrentDraft(state, { auth: requestAuth }),
					};
				}),
			clearRequestState: () =>
				set({
					requestPathParams: {},
					requestQueryParams: {},
					requestHeaders: {},
					requestBody: "",
					requestAuth: { ...DEFAULT_REQUEST_AUTH },
				}),

			// Response actions
			setResponse: ({ status, statusText, headers, body, time }) =>
				set({
					responseStatus: status,
					responseStatusText: statusText,
					responseHeaders: headers,
					responseBody: body,
					responseTime: time,
					isSendingRequest: false,
				}),
			clearResponse: () =>
				set({
					responseStatus: null,
					responseStatusText: "",
					responseHeaders: {},
					responseBody: "",
					responseTime: null,
				}),
			setIsSendingRequest: (isSendingRequest) => set({ isSendingRequest }),
		}),
		{
			name: "api-explorer-store",
			partialize: (state) => ({
				specUrlsByProject: state.specUrlsByProject,
				environments: state.environments.map(({ token: _token, ...env }) => env),
				activeEnvironmentId: state.activeEnvironmentId,
				collapsedTags: state.collapsedTags,
				selectedEndpointByProject: state.selectedEndpointByProject,
				requestDrafts: Object.fromEntries(
					Object.entries(state.requestDrafts).map(([key, draft]) => [
						key,
						{ ...draft, auth: withoutSecrets(draft.auth) },
					]),
				),
			}),
		},
	),
);
