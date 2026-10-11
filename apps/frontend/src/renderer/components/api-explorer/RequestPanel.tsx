/**
 * The request panel of the API Explorer: parameters, headers and body editors,
 * sending the request and showing the response, code samples. Split out of
 * ApiExplorer.tsx (audit lot L11, F36).
 */

import {
	Check,
	ChevronDown,
	Copy,
	Loader2,
	Plus,
	Send,
	Shield,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import {
	type AuthType,
	makeEndpointKey,
	type OAuth2GrantType,
	type OpenApiOperation,
	type OpenApiParameter,
	type OpenApiSpec,
	useApiExplorerStore,
} from "../../stores/api-explorer-store";
import { useProjectStore } from "../../stores/project-store";
import {
	getStatusColor,
	prettifyXml,
	escapeHtml,
	syntaxHighlightJson,
	detectContentType,
	resolveRef,
	MethodBadge,
} from "./api-explorer-shared";

// ── Schema Viewer ────────────────────────────────────────────────────────────

export interface SchemaViewerProps {
	readonly schema: Record<string, unknown>;
	readonly spec: OpenApiSpec;
	readonly depth?: number;
}

export function SchemaViewer({ schema, spec, depth = 0 }: SchemaViewerProps) {
	const resolved = useMemo(() => {
		if (schema.$ref && typeof schema.$ref === "string") {
			return resolveRef(schema.$ref, spec) ?? schema;
		}
		return schema;
	}, [schema, spec]);

	const type = resolved.type as string | undefined;
	const properties = resolved.properties as
		| Record<string, Record<string, unknown>>
		| undefined;
	const required = resolved.required as string[] | undefined;
	const items = resolved.items as Record<string, unknown> | undefined;
	const description = resolved.description as string | undefined;

	if (depth > 4)
		return <span className="text-[var(--color-text-muted)] text-xs">...</span>;

	if (type === "object" && properties) {
		return (
			<div
				className={
					depth > 0 ? "ml-3 border-l border-[var(--color-border)] pl-3" : ""
				}
			>
				{Object.entries(properties).map(([key, val]) => (
					<div key={key} className="py-0.5">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-mono text-xs text-[var(--color-text-primary)] font-medium">
								{key}
							</span>
							{required?.includes(key) && (
								<span className="text-[9px] text-red-400 font-mono border border-red-400/30 rounded px-1">
									required
								</span>
							)}
							<span className="text-[10px] font-mono text-blue-400/80">
								{(val.type as string) ?? (val.$ref ? "↗ ref" : "?")}
							</span>
							{!!val.description && (
								<span className="text-xs text-[var(--color-text-muted)]">
									— {String(val.description)}
								</span>
							)}
						</div>
						{(val.type === "object" || val.$ref || val.type === "array") && (
							<SchemaViewer schema={val} spec={spec} depth={depth + 1} />
						)}
					</div>
				))}
			</div>
		);
	}

	if (type === "array" && items) {
		return (
			<div
				className={
					depth > 0 ? "ml-3 border-l border-[var(--color-border)] pl-3" : ""
				}
			>
				<span className="text-xs text-[var(--color-text-muted)]">items:</span>
				<SchemaViewer schema={items} spec={spec} depth={depth + 1} />
			</div>
		);
	}

	return (
		<span className="text-xs text-[var(--color-text-muted)]">
			{type ?? "any"}
			{description ? ` — ${description}` : ""}
		</span>
	);
}

// ── Request Panel ────────────────────────────────────────────────────────────

export interface RequestPanelProps {
	readonly method: string;
	readonly path: string;
	readonly operation: OpenApiOperation;
	readonly spec: OpenApiSpec;
	readonly onOpenEnvManager: () => void;
}

export function RequestPanel({
	method,
	path,
	operation,
	spec,
	onOpenEnvManager,
}: RequestPanelProps) {
	const { t } = useTranslation(["apiExplorer"]);
	const environments = useApiExplorerStore((s) => s.environments);
	const activeEnvironmentId = useApiExplorerStore((s) => s.activeEnvironmentId);
	const activeEnv =
		environments.find((e) => e.id === activeEnvironmentId) ?? environments[0];

	const requestPathParams = useApiExplorerStore((s) => s.requestPathParams);
	const requestQueryParams = useApiExplorerStore((s) => s.requestQueryParams);
	const requestHeaders = useApiExplorerStore((s) => s.requestHeaders);
	const requestBody = useApiExplorerStore((s) => s.requestBody);
	const isSendingRequest = useApiExplorerStore((s) => s.isSendingRequest);
	const responseStatus = useApiExplorerStore((s) => s.responseStatus);
	const responseStatusText = useApiExplorerStore((s) => s.responseStatusText);
	const responseHeaders = useApiExplorerStore((s) => s.responseHeaders);
	const responseBody = useApiExplorerStore((s) => s.responseBody);
	const responseTime = useApiExplorerStore((s) => s.responseTime);

	const requestAuth = useApiExplorerStore((s) => s.requestAuth);
	const setRequestPathParams = useApiExplorerStore(
		(s) => s.setRequestPathParams,
	);
	const setRequestQueryParams = useApiExplorerStore(
		(s) => s.setRequestQueryParams,
	);
	const setRequestHeaders = useApiExplorerStore((s) => s.setRequestHeaders);
	const setRequestBody = useApiExplorerStore((s) => s.setRequestBody);
	const setRequestAuth = useApiExplorerStore((s) => s.setRequestAuth);
	const setResponse = useApiExplorerStore((s) => s.setResponse);
	const clearResponse = useApiExplorerStore((s) => s.clearResponse);
	const setIsSendingRequest = useApiExplorerStore((s) => s.setIsSendingRequest);
	const updateEnvironment = useApiExplorerStore((s) => s.updateEnvironment);
	const activeProjectId = useProjectStore((s) => s.activeProjectId);
	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
	const projectId = activeProjectId ?? selectedProjectId;
	const secretScope = projectId
		? `request:${projectId}:${makeEndpointKey(method, path)}`
		: null;
	const loadedSecretScope = useRef<string | null>(null);

	useEffect(() => {
		if (!secretScope) return;
		let cancelled = false;
		loadedSecretScope.current = null;
		void globalThis.electronAPI
			.loadApiExplorerSecrets(secretScope)
			.then((requestResult) => {
			if (cancelled) return;
			if (requestResult.success && requestResult.data) {
				setRequestAuth({
					bearer: requestResult.data.bearer ?? "",
					password: requestResult.data.password ?? "",
					keyValue: requestResult.data.keyValue ?? "",
					oauth2ClientSecret:
						requestResult.data.oauth2ClientSecret ?? "",
					oauth2AccessToken: requestResult.data.oauth2AccessToken ?? "",
				});
			}
			loadedSecretScope.current = secretScope;
			});
		return () => {
			cancelled = true;
		};
	}, [
		secretScope,
		setRequestAuth,
	]);

	useEffect(() => {
		if (
			!secretScope || loadedSecretScope.current !== secretScope
		)
			return;
		void globalThis.electronAPI.saveApiExplorerSecrets(secretScope, {
			bearer: requestAuth.bearer,
			password: requestAuth.password,
			keyValue: requestAuth.keyValue,
			oauth2ClientSecret: requestAuth.oauth2ClientSecret,
			oauth2AccessToken: requestAuth.oauth2AccessToken,
		});
	}, [
		secretScope,
		requestAuth.bearer,
		requestAuth.password,
		requestAuth.keyValue,
		requestAuth.oauth2ClientSecret,
		requestAuth.oauth2AccessToken,
	]);

	// Extract a token from a JSON response body (common field names)
	const TOKEN_FIELDS = [
		"access_token",
		"token",
		"jwt",
		"auth_token",
		"id_token",
		"bearer_token",
		"accessToken",
		"authToken",
		"idToken",
	] as const;

	const [showAuthToken, setShowAuthToken] = useState(false);
	const [showAuthPassword, setShowAuthPassword] = useState(false);
	const [showOAuth2Secret, setShowOAuth2Secret] = useState(false);
	const [showOAuth2Token, setShowOAuth2Token] = useState(false);
	const [isGettingOAuth2Token, setIsGettingOAuth2Token] = useState(false);
	const [oauth2TokenError, setOAuth2TokenError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<
		"params" | "auth" | "headers" | "body" | "docs"
	>("params");
	const [responseTab, setResponseTab] = useState<"body" | "headers">("body");
	const [responseFormat, setResponseFormat] = useState<
		"pretty" | "raw" | "preview"
	>("pretty");
	const [responseLanguage, setResponseLanguage] =
		useState<ResponseLanguage>("auto");
	const [responsePanelHeight, setResponsePanelHeight] = useState(240);
	const isDraggingDivider = useRef(false);
	const dragStartY = useRef(0);
	const dragStartHeight = useRef(0);
	const [copiedResponse, setCopiedResponse] = useState(false);
	const [savedToken, setSavedToken] = useState(false);

	const extractedToken = useMemo<string | null>(() => {
		if (
			!responseBody ||
			!responseStatus ||
			responseStatus < 200 ||
			responseStatus >= 300
		)
			return null;
		try {
			const json = JSON.parse(responseBody) as Record<string, unknown>;
			for (const field of TOKEN_FIELDS) {
				if (typeof json[field] === "string" && json[field].length > 10) {
					return json[field];
				}
			}
		} catch {
			/* not JSON */
		}
		return null;
	}, [responseBody, responseStatus, TOKEN_FIELDS]);

	// Auto-select the best format and language when a new response arrives
	useEffect(() => {
		if (!responseBody) return;
		const ct = detectContentType(responseHeaders);
		setResponseLanguage("auto");
		if (ct.includes("text/html")) {
			setResponseFormat("preview");
		} else {
			setResponseFormat("pretty");
		}
	}, [responseBody, responseHeaders]);

	// Drag-to-resize response panel
	useEffect(() => {
		function onMouseMove(e: MouseEvent) {
			if (!isDraggingDivider.current) return;
			const delta = dragStartY.current - e.clientY;
			setResponsePanelHeight(
				Math.max(80, Math.min(700, dragStartHeight.current + delta)),
			);
		}
		function onMouseUp() {
			if (!isDraggingDivider.current) return;
			isDraggingDivider.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		}
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, []);

	function saveTokenToEnv() {
		if (!extractedToken || !activeEnv) return;
		updateEnvironment(activeEnv.id, { token: extractedToken });
		setRequestAuth({ type: "inherited" });
		setSavedToken(true);
		setTimeout(() => setSavedToken(false), 2500);
	}

	// Custom key/value rows (free-form, not from spec)
	const [customQueryRows, setCustomQueryRows] = useState<
		Array<{ id: string; enabled: boolean; key: string; value: string }>
	>([]);
	const [customHeaderRows, setCustomHeaderRows] = useState<
		Array<{ id: string; enabled: boolean; key: string; value: string }>
	>([]);

	function addCustomQueryRow() {
		setCustomQueryRows((r) => [
			...r,
			{ id: `cqr-${Date.now()}`, enabled: true, key: "", value: "" },
		]);
	}
	function updateCustomQueryRow(
		id: string,
		field: CustomRowField,
		val: CustomRowValue,
	) {
		setCustomQueryRows((r) =>
			r.map((row) => (row.id === id ? { ...row, [field]: val } : row)),
		);
	}
	function removeCustomQueryRow(id: string) {
		setCustomQueryRows((r) => r.filter((row) => row.id !== id));
	}

	function addCustomHeaderRow() {
		setCustomHeaderRows((r) => [
			...r,
			{ id: `chr-${Date.now()}`, enabled: true, key: "", value: "" },
		]);
	}
	function updateCustomHeaderRow(
		id: string,
		field: CustomRowField,
		val: CustomRowValue,
	) {
		setCustomHeaderRows((r) =>
			r.map((row) => (row.id === id ? { ...row, [field]: val } : row)),
		);
	}
	function removeCustomHeaderRow(id: string) {
		setCustomHeaderRows((r) => r.filter((row) => row.id !== id));
	}

	const pathParams = useMemo(
		() => (operation.parameters ?? []).filter((p) => p.in === "path"),
		[operation.parameters],
	);
	const queryParams = useMemo(
		() => (operation.parameters ?? []).filter((p) => p.in === "query"),
		[operation.parameters],
	);
	const headerParams = useMemo(
		() => (operation.parameters ?? []).filter((p) => p.in === "header"),
		[operation.parameters],
	);

	const hasBody =
		method.toLowerCase() !== "get" &&
		method.toLowerCase() !== "head" &&
		operation.requestBody;

	const responseCodes = Object.keys(operation.responses ?? {});
	const requestBodySchema = operation.requestBody
		? Object.values(operation.requestBody.content ?? {})[0]?.schema
		: null;

	// Build the resolved URL preview
	const resolvedUrl = useMemo(() => {
		let url = `${activeEnv?.baseUrl ?? ""}${path}`;
		for (const [key, val] of Object.entries(requestPathParams)) {
			if (val) url = url.replace(`{${key}}`, encodeURIComponent(val));
		}
		const qp = [
			...Object.entries(requestQueryParams).filter(([, v]) => v),
			...customQueryRows
				.filter((r) => r.enabled && r.key)
				.map((r) => [r.key, r.value] as [string, string]),
		];
		if (qp.length > 0) {
			url +=
				"?" +
				qp
					.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
					.join("&");
		}
		return url;
	}, [activeEnv, path, requestPathParams, requestQueryParams, customQueryRows]);

	async function sendRequest() {
		setIsSendingRequest(true);
		clearResponse();

		const headers: Record<string, string> = {
			// Environment-level headers
			...Object.fromEntries(
				Object.entries(activeEnv?.headers ?? {}).filter(([, v]) => v),
			),
			// Spec-defined header params
			...Object.fromEntries(
				Object.entries(requestHeaders).filter(([, v]) => v),
			),
			// User-added custom headers
			...Object.fromEntries(
				customHeaderRows
					.filter((r) => r.enabled && r.key)
					.map((r) => [r.key, r.value]),
			),
		};

		// Build final URL — resolvedUrl already includes spec+custom query params, but for API key in query we rebuild
		let finalUrl = resolvedUrl;

		// Authentication
		if (requestAuth.type === "bearer" && requestAuth.bearer) {
			headers.Authorization = `Bearer ${requestAuth.bearer}`;
		} else if (
			requestAuth.type === "basic" &&
			(requestAuth.username || requestAuth.password)
		) {
			headers.Authorization = `Basic ${btoa(`${requestAuth.username}:${requestAuth.password}`)}`;
		} else if (
			requestAuth.type === "apikey" &&
			requestAuth.keyName &&
			requestAuth.keyValue
		) {
			if (requestAuth.keyLocation === "header") {
				headers[requestAuth.keyName] = requestAuth.keyValue;
			} else {
				// Append API key to query string
				const sep = finalUrl.includes("?") ? "&" : "?";
				finalUrl += `${sep}${encodeURIComponent(requestAuth.keyName)}=${encodeURIComponent(requestAuth.keyValue)}`;
			}
		} else if (requestAuth.type === "inherited") {
			if (
				activeEnv?.token &&
				!headers.Authorization &&
				!headers.authorization
			) {
				headers.Authorization = `Bearer ${activeEnv.token}`;
			}
		} else if (requestAuth.type === "oauth2" && requestAuth.oauth2AccessToken) {
			const prefix = requestAuth.oauth2HeaderPrefix || "Bearer";
			headers.Authorization = `${prefix} ${requestAuth.oauth2AccessToken}`;
		}
		// type === 'none' → no Authorization header added

		if (hasBody && requestBody) {
			headers["Content-Type"] = "application/json";
		}

		try {
			const result = await globalThis.electronAPI.proxyHttpRequest({
				url: finalUrl,
				method: method.toUpperCase(),
				headers,
				body: hasBody && requestBody ? requestBody : undefined,
			});

			setResponse({
				status: result.status ?? 0,
				statusText:
					result.statusText ??
					(result.success ? "OK" : t("apiExplorer:request.networkError")),
				headers: result.headers ?? {},
				body: result.body ?? "",
				time: result.time ?? 0,
			});
		} catch (err) {
			setResponse({
				status: 0,
				statusText: t("apiExplorer:request.networkError"),
				headers: {},
				body: String(err),
				time: 0,
			});
		}
	}

	async function handleGetOAuth2Token() {
		setIsGettingOAuth2Token(true);
		setOAuth2TokenError(null);
		try {
			const {
				oauth2GrantType,
				oauth2TokenUrl,
				oauth2AuthUrl,
				oauth2ClientId,
				oauth2ClientSecret,
				oauth2Scope,
			} = requestAuth;

			if (oauth2GrantType === "authorization_code") {
				// For auth code flow, open auth URL in browser — user pastes token manually
				if (oauth2AuthUrl) {
					window.open(oauth2AuthUrl, "_blank");
				}
				setIsGettingOAuth2Token(false);
				return;
			}

			if (!oauth2TokenUrl) {
				setOAuth2TokenError(t("apiExplorer:auth.oauth2.missingTokenUrl"));
				setIsGettingOAuth2Token(false);
				return;
			}

			const body = new URLSearchParams();
			body.append("grant_type", oauth2GrantType);
			if (oauth2ClientId) body.append("client_id", oauth2ClientId);
			if (oauth2ClientSecret) body.append("client_secret", oauth2ClientSecret);
			if (oauth2Scope) body.append("scope", oauth2Scope);
			if (oauth2GrantType === "password") {
				body.append("username", requestAuth.username);
				body.append("password", requestAuth.password);
			}

			const res = await fetch(oauth2TokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});
			const data = (await res.json()) as Record<string, unknown>;
			if (typeof data.access_token === "string") {
				setRequestAuth({ oauth2AccessToken: data.access_token });
			} else {
				const errDesc =
					typeof data.error_description === "string"
						? data.error_description
						: null;
				const errCode = typeof data.error === "string" ? data.error : null;
				setOAuth2TokenError(
					errDesc ?? errCode ?? t("apiExplorer:auth.oauth2.tokenError"),
				);
			}
		} catch (err) {
			setOAuth2TokenError(String(err));
		} finally {
			setIsGettingOAuth2Token(false);
		}
	}

	function copyResponse() {
		navigator.clipboard.writeText(responseBody);
		setCopiedResponse(true);
		setTimeout(() => setCopiedResponse(false), 2000);
	}

	function updatePathParam(name: string, value: string) {
		setRequestPathParams({ ...requestPathParams, [name]: value });
	}

	function updateQueryParam(name: string, value: string) {
		setRequestQueryParams({ ...requestQueryParams, [name]: value });
	}

	function updateHeaderParam(name: string, value: string) {
		setRequestHeaders({ ...requestHeaders, [name]: value });
	}

	const authIsActive =
		requestAuth.type !== "inherited" && requestAuth.type !== "none";
	const authInherited = requestAuth.type === "inherited" && !!activeEnv?.token;
	const tabs = [
		{
			id: "params" as const,
			label: `${t("apiExplorer:request.params")} (${pathParams.length + queryParams.length})`,
		},
		{
			id: "auth" as const,
			label: t("apiExplorer:request.auth"),
			badge: authIsActive || authInherited,
		},
		{
			id: "headers" as const,
			label: `${t("apiExplorer:request.headers")} (${headerParams.length})`,
		},
		...(hasBody
			? [{ id: "body" as const, label: t("apiExplorer:request.body") }]
			: []),
		{ id: "docs" as const, label: t("apiExplorer:detail.docs") },
	];

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* URL bar — Postman-style */}
			<div className="px-5 pt-4 pb-0 shrink-0">
				<div className="flex items-stretch bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg overflow-hidden">
					<div className="flex items-center px-3 border-r border-[var(--color-border)] shrink-0 bg-[var(--color-bg-tertiary)]">
						<MethodBadge method={method} size="md" />
					</div>
					<span className="font-mono text-sm text-[var(--color-text-primary)] flex-1 px-3 py-2.5 truncate">
						{resolvedUrl}
					</span>
					<Button
						size="sm"
						onClick={sendRequest}
						disabled={isSendingRequest}
						className="shrink-0 m-1.5 flex items-center gap-1.5 px-4"
					>
						{isSendingRequest ? (
							<Loader2 size={13} className="animate-spin" />
						) : (
							<Send size={13} />
						)}
						{t("apiExplorer:request.send")}
					</Button>
				</div>
			</div>

			{/* Request tabs */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="flex border-b border-[var(--color-border)] px-5">
					{tabs.map((tab) => (
						<button
							type="button"
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							className={`relative px-4 py-2 text-xs font-medium transition-colors flex items-center gap-1.5 ${
								activeTab === tab.id
									? "text-[var(--color-text-primary)]"
									: "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
							}`}
						>
							{tab.label}
							{"badge" in tab && tab.badge && (
								<span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
							)}
							{activeTab === tab.id && (
								<span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-primary)]" />
							)}
						</button>
					))}
				</div>

				<div className="px-5 pt-3 pb-4 min-h-[100px]">
					{activeTab === "params" && (
						<div className="space-y-4">
							{pathParams.length > 0 && (
								<div>
									<div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
										{t("apiExplorer:request.pathParams")}
									</div>
									{pathParams.map((p) => (
										<ParamRow
											key={p.name}
											param={p}
											value={requestPathParams[p.name] ?? ""}
											onChange={(v) => updatePathParam(p.name, v)}
										/>
									))}
								</div>
							)}
							<div>
								{queryParams.length > 0 && (
									<>
										<div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
											{t("apiExplorer:request.queryParams")}
										</div>
										{queryParams.map((p) => (
											<ParamRow
												key={p.name}
												param={p}
												value={requestQueryParams[p.name] ?? ""}
												onChange={(v) => updateQueryParam(p.name, v)}
											/>
										))}
										{customQueryRows.length > 0 && (
											<div className="my-2 border-t border-[var(--color-border)]" />
										)}
									</>
								)}
								<KeyValueEditor
									rows={customQueryRows}
									onAdd={addCustomQueryRow}
									onUpdate={updateCustomQueryRow}
									onRemove={removeCustomQueryRow}
									keyPlaceholder={t("apiExplorer:request.paramKey")}
									valuePlaceholder={t("apiExplorer:request.paramValue")}
									addLabel={t("apiExplorer:request.addParam")}
								/>
							</div>
						</div>
					)}

					{activeTab === "headers" && (
						<div className="space-y-3">
							{headerParams.length > 0 && (
								<div>
									<div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
										{t("apiExplorer:request.specHeaders")}
									</div>
									{headerParams.map((p) => (
										<ParamRow
											key={p.name}
											param={p}
											value={requestHeaders[p.name] ?? ""}
											onChange={(v) => updateHeaderParam(p.name, v)}
										/>
									))}
									<div className="mt-3 border-t border-[var(--color-border)]" />
								</div>
							)}
							<KeyValueEditor
								rows={customHeaderRows}
								onAdd={addCustomHeaderRow}
								onUpdate={updateCustomHeaderRow}
								onRemove={removeCustomHeaderRow}
								keyPlaceholder={t("apiExplorer:request.headerKey")}
								valuePlaceholder={t("apiExplorer:request.headerValue")}
								addLabel={t("apiExplorer:request.addHeader")}
							/>
						</div>
					)}

					{activeTab === "auth" && (
						<div className="space-y-4">
							{/* Auth type selector */}
							<div>
								{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
								<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
									{t("apiExplorer:auth.type")}
								</label>
								<CustomSelect
									value={requestAuth.type}
									onChange={(v) => setRequestAuth({ type: v as AuthType })}
									options={(
										[
											"inherited",
											"none",
											"bearer",
											"basic",
											"apikey",
											"oauth2",
										] as AuthType[]
									).map((type) => ({
										value: type,
										label: t(`apiExplorer:auth.types.${type}`),
									}))}
								/>
							</div>

							{/* Inherited from environment */}
							{requestAuth.type === "inherited" && (
								<div
									className={`rounded-lg p-3 text-xs ${activeEnv?.token ? "bg-amber-400/5 border border-amber-400/20" : "bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"}`}
								>
									{activeEnv?.token ? (
										<div className="flex items-start gap-2">
											<span className="text-amber-400 mt-0.5">🔑</span>
											<div>
												<div className="font-medium text-amber-400">
													{t("apiExplorer:auth.inheritedFrom", {
														env: activeEnv.name,
													})}
												</div>
												<div className="text-[var(--color-text-muted)] mt-0.5 font-mono">
													Authorization: Bearer ••••{activeEnv.token.slice(-6)}
												</div>
											</div>
										</div>
									) : (
										<div className="text-[var(--color-text-muted)]">
											{t("apiExplorer:auth.noEnvToken", {
												env: activeEnv?.name ?? "Local",
											})}
											<button
												type="button"
												onClick={onOpenEnvManager}
												className="ml-1 text-[var(--color-primary)] hover:underline focus:outline-none font-medium"
											>
												{t("apiExplorer:auth.configureEnv")}
											</button>
										</div>
									)}
								</div>
							)}

							{/* No auth */}
							{requestAuth.type === "none" && (
								<div className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3">
									{t("apiExplorer:auth.noAuthDesc")}
								</div>
							)}

							{/* Bearer Token */}
							{requestAuth.type === "bearer" && (
								<div className="space-y-2">
									{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
									<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block">
										{t("apiExplorer:auth.token")}
									</label>
									<div className="flex gap-2">
										<input
											type={showAuthToken ? "text" : "password"}
											className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
											value={requestAuth.bearer}
											onChange={(e) =>
												setRequestAuth({ bearer: e.target.value })
											}
											placeholder={t("apiExplorer:auth.tokenPlaceholder")}
										/>
										<button
											type="button"
											onClick={() => setShowAuthToken((v) => !v)}
											className="px-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-md bg-[var(--color-bg-secondary)] transition-colors text-sm"
										>
											{showAuthToken ? "🙈" : "👁"}
										</button>
									</div>
									<div className="text-[10px] text-[var(--color-text-muted)]">
										{t("apiExplorer:auth.bearerHint")}
									</div>
								</div>
							)}

							{/* Basic Auth */}
							{requestAuth.type === "basic" && (
								<div className="space-y-2">
									<div>
										{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
										<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
											{t("apiExplorer:auth.username")}
										</label>
										<input
											type="text"
											className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
											value={requestAuth.username}
											onChange={(e) =>
												setRequestAuth({ username: e.target.value })
											}
											placeholder={t("apiExplorer:auth.usernamePlaceholder")}
										/>
									</div>
									<div>
										{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
										<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
											{t("apiExplorer:auth.password")}
										</label>
										<div className="flex gap-2">
											<input
												type={showAuthPassword ? "text" : "password"}
												className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.password}
												onChange={(e) =>
													setRequestAuth({ password: e.target.value })
												}
												placeholder="••••••••"
											/>
											<button
												type="button"
												onClick={() => setShowAuthPassword((v) => !v)}
												className="px-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-md bg-[var(--color-bg-secondary)] transition-colors text-sm"
											>
												{showAuthPassword ? "🙈" : "👁"}
											</button>
										</div>
									</div>
									<div className="text-[10px] text-[var(--color-text-muted)]">
										{t("apiExplorer:auth.basicHint")}
									</div>
								</div>
							)}

							{/* API Key */}
							{requestAuth.type === "apikey" && (
								<div className="space-y-2">
									<div className="grid grid-cols-2 gap-2">
										<div>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
											<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
												{t("apiExplorer:auth.keyName")}
											</label>
											<input
												type="text"
												className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.keyName}
												onChange={(e) =>
													setRequestAuth({ keyName: e.target.value })
												}
												placeholder="X-API-Key"
											/>
										</div>
										<div>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
											<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
												{t("apiExplorer:auth.addTo")}
											</label>
											<CustomSelect
												value={requestAuth.keyLocation}
												onChange={(v) =>
													setRequestAuth({
														keyLocation: v as "header" | "query",
													})
												}
												options={[
													{
														value: "header",
														label: t("apiExplorer:auth.locationHeader"),
													},
													{
														value: "query",
														label: t("apiExplorer:auth.locationQuery"),
													},
												]}
											/>
										</div>
									</div>
									<div>
										{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
										<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
											{t("apiExplorer:auth.keyValue")}
										</label>
										<input
											type="text"
											className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
											value={requestAuth.keyValue}
											onChange={(e) =>
												setRequestAuth({ keyValue: e.target.value })
											}
											placeholder={t("apiExplorer:auth.keyValuePlaceholder")}
										/>
									</div>
								</div>
							)}

							{/* OAuth 2.0 */}
							{requestAuth.type === "oauth2" && (
								<div className="space-y-3">
									{/* Grant Type */}
									<div>
										{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
										<label className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider block mb-1">
											{t("apiExplorer:auth.oauth2.grantType")}
										</label>
										<CustomSelect
											value={requestAuth.oauth2GrantType}
											onChange={(v) =>
												setRequestAuth({
													oauth2GrantType: v as OAuth2GrantType,
												})
											}
											options={[
												{
													value: "client_credentials",
													label: t(
														"apiExplorer:auth.oauth2.grants.client_credentials",
													),
												},
												{
													value: "authorization_code",
													label: t(
														"apiExplorer:auth.oauth2.grants.authorization_code",
													),
												},
												{
													value: "password",
													label: t("apiExplorer:auth.oauth2.grants.password"),
												},
											]}
										/>
									</div>

									{/* Configure New Token */}
									<div className="border border-[var(--color-border)] rounded-lg p-3 space-y-2.5">
										<div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
											{t("apiExplorer:auth.oauth2.configureToken")}
										</div>

										{/* Auth URL — only for authorization_code */}
										{requestAuth.oauth2GrantType === "authorization_code" && (
											<div>
												{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
												<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
													{t("apiExplorer:auth.oauth2.authUrl")}
												</label>
												<input
													type="url"
													className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
													value={requestAuth.oauth2AuthUrl}
													onChange={(e) =>
														setRequestAuth({ oauth2AuthUrl: e.target.value })
													}
													placeholder="https://auth.example.com/authorize"
												/>
											</div>
										)}

										{/* Token URL */}
										{requestAuth.oauth2GrantType !== "authorization_code" && (
											<div>
												{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
												<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
													{t("apiExplorer:auth.oauth2.tokenUrl")}
												</label>
												<input
													type="url"
													className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
													value={requestAuth.oauth2TokenUrl}
													onChange={(e) =>
														setRequestAuth({ oauth2TokenUrl: e.target.value })
													}
													placeholder="https://auth.example.com/token"
												/>
											</div>
										)}

										{/* Client ID */}
										<div>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
											<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
												{t("apiExplorer:auth.oauth2.clientId")}
											</label>
											<input
												type="text"
												className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.oauth2ClientId}
												onChange={(e) =>
													setRequestAuth({ oauth2ClientId: e.target.value })
												}
												placeholder="client_id"
											/>
										</div>

										{/* Client Secret */}
										<div>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
											<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
												{t("apiExplorer:auth.oauth2.clientSecret")}
											</label>
											<div className="flex gap-2">
												<input
													type={showOAuth2Secret ? "text" : "password"}
													className="flex-1 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
													value={requestAuth.oauth2ClientSecret}
													onChange={(e) =>
														setRequestAuth({
															oauth2ClientSecret: e.target.value,
														})
													}
													placeholder="client_secret"
												/>
												<button
													type="button"
													onClick={() => setShowOAuth2Secret((v) => !v)}
													className="px-2.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-md bg-[var(--color-bg-primary)] transition-colors text-sm"
												>
													{showOAuth2Secret ? "🙈" : "👁"}
												</button>
											</div>
										</div>

										{/* Scope */}
										<div>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
											<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
												{t("apiExplorer:auth.oauth2.scope")}
											</label>
											<input
												type="text"
												className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.oauth2Scope}
												onChange={(e) =>
													setRequestAuth({ oauth2Scope: e.target.value })
												}
												placeholder="openid profile email"
											/>
										</div>

										{/* Password fields — only for password grant */}
										{requestAuth.oauth2GrantType === "password" && (
											<div className="grid grid-cols-2 gap-2">
												<div>
													{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
													<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
														{t("apiExplorer:auth.username")}
													</label>
													<input
														type="text"
														className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
														value={requestAuth.username}
														onChange={(e) =>
															setRequestAuth({ username: e.target.value })
														}
														placeholder={t(
															"apiExplorer:auth.usernamePlaceholder",
														)}
													/>
												</div>
												<div>
													{/* biome-ignore lint/a11y/noLabelWithoutControl: intentional */}
													<label className="text-[10px] text-[var(--color-text-muted)] block mb-1">
														{t("apiExplorer:auth.password")}
													</label>
													<input
														type="password"
														className="w-full bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-md px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
														value={requestAuth.password}
														onChange={(e) =>
															setRequestAuth({ password: e.target.value })
														}
														placeholder="••••••••"
													/>
												</div>
											</div>
										)}

										{/* Error */}
										{oauth2TokenError && (
											<div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-2.5 py-1.5">
												{oauth2TokenError}
											</div>
										)}

										{/* Get Token button */}
										<button
											type="button"
											onClick={handleGetOAuth2Token}
											disabled={isGettingOAuth2Token}
											className="w-full py-2 rounded-md text-xs font-semibold bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
										>
											{isGettingOAuth2Token && (
												<Loader2 size={12} className="animate-spin" />
											)}
											{requestAuth.oauth2GrantType === "authorization_code"
												? t("apiExplorer:auth.oauth2.openBrowser")
												: t("apiExplorer:auth.oauth2.getToken")}
										</button>
									</div>

									{/* Current Token */}
									<div className="space-y-2">
										<div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
											{t("apiExplorer:auth.oauth2.currentToken")}
										</div>
										<div className="flex gap-2">
											<input
												type={showOAuth2Token ? "text" : "password"}
												className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.oauth2AccessToken}
												onChange={(e) =>
													setRequestAuth({ oauth2AccessToken: e.target.value })
												}
												placeholder={t(
													"apiExplorer:auth.oauth2.tokenPlaceholder",
												)}
											/>
											<button
												type="button"
												onClick={() => setShowOAuth2Token((v) => !v)}
												className="px-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-md bg-[var(--color-bg-secondary)] transition-colors text-sm"
											>
												{showOAuth2Token ? "🙈" : "👁"}
											</button>
										</div>
										<div className="flex items-center gap-2">
											<span className="text-[10px] text-[var(--color-text-muted)]">
												{t("apiExplorer:auth.oauth2.headerPrefix")}
											</span>
											<input
												type="text"
												className="w-24 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
												value={requestAuth.oauth2HeaderPrefix}
												onChange={(e) =>
													setRequestAuth({ oauth2HeaderPrefix: e.target.value })
												}
											/>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{activeTab === "body" && hasBody && (
						<div>
							<textarea
								className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded p-2 text-xs font-mono text-[var(--color-text-primary)] resize-none focus:outline-none focus:border-[var(--color-accent)] min-h-[120px]"
								value={requestBody}
								onChange={(e) => setRequestBody(e.target.value)}
								placeholder={getBodyPlaceholder(operation, spec)}
								spellCheck={false}
							/>
							<button
								type="button"
								onClick={() => {
									const placeholder = getBodyPlaceholder(operation, spec);
									if (placeholder && placeholder !== "{}")
										setRequestBody(placeholder);
								}}
								className="mt-1.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
							>
								{t("apiExplorer:request.fillExample")}
							</button>
						</div>
					)}

					{activeTab === "docs" && (
						<div className="space-y-6">
							{operation.description && (
								<div>
									<h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
										{t("apiExplorer:detail.description")}
									</h4>
									<p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
										{operation.description}
									</p>
								</div>
							)}
							{(operation.parameters ?? []).length > 0 && (
								<div>
									<h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
										{t("apiExplorer:detail.parameters")}
									</h4>
									<div className="space-y-2">
										{(operation.parameters ?? []).map((p) => (
											<div
												key={`${p.in}-${p.name}`}
												className="flex items-start gap-3 p-2.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
											>
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2 flex-wrap">
														<code className="text-xs font-mono font-semibold text-[var(--color-text-primary)]">
															{p.name}
														</code>
														<span className="text-[10px] font-mono text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1">
															{p.in}
														</span>
														<span className="text-[10px] font-mono text-blue-400/80">
															{p.schema?.type ?? "any"}
														</span>
														{p.required && (
															<span className="text-[9px] text-red-400 border border-red-400/30 rounded px-1">
																required
															</span>
														)}
													</div>
													{p.description && (
														<p className="text-xs text-[var(--color-text-muted)] mt-1">
															{p.description}
														</p>
													)}
												</div>
											</div>
										))}
									</div>
								</div>
							)}
							{requestBodySchema && (
								<div>
									<h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
										{t("apiExplorer:detail.requestBody")}
									</h4>
									<div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3">
										<SchemaViewer
											schema={requestBodySchema as Record<string, unknown>}
											spec={spec}
										/>
									</div>
								</div>
							)}
							{responseCodes.length > 0 && (
								<div>
									<h4 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
										{t("apiExplorer:detail.responses")}
									</h4>
									<div className="space-y-2">
										{responseCodes.map((code) => {
											const resp = operation.responses?.[code];
											const schema = resp?.content
												? Object.values(resp.content)[0]?.schema
												: null;
											return (
												<div key={code} className="space-y-1">
													<div className="flex items-start gap-3 p-2.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
														<span
															className={`font-mono text-sm font-bold shrink-0 ${getStatusColor(parseInt(code, 10))}`}
														>
															{code}
														</span>
														<span className="text-sm text-[var(--color-text-secondary)]">
															{resp?.description ?? "—"}
														</span>
													</div>
													{schema && (
														<div className="ml-4 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3">
															<SchemaViewer
																schema={schema as Record<string, unknown>}
																spec={spec}
															/>
														</div>
													)}
												</div>
											);
										})}
									</div>
								</div>
							)}
							{!operation.description &&
								(operation.parameters ?? []).length === 0 &&
								!requestBodySchema &&
								responseCodes.length === 0 && (
									<div className="text-sm text-[var(--color-text-muted)] text-center py-8">
										{t("apiExplorer:detail.noSchema")}
									</div>
								)}
						</div>
					)}
				</div>
			</div>

			{/* Response */}
			{(responseStatus !== null || isSendingRequest) && (
				<>
					{/* Drag handle */}
					{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: resize drag handle */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: resize drag handle */}
					<div
						className="shrink-0 h-2 flex items-center justify-center cursor-row-resize group select-none"
						onMouseDown={(e) => {
							isDraggingDivider.current = true;
							dragStartY.current = e.clientY;
							dragStartHeight.current = responsePanelHeight;
							document.body.style.cursor = "row-resize";
							document.body.style.userSelect = "none";
						}}
					>
						<div className="w-10 h-0.5 rounded-full bg-[var(--color-border)] group-hover:bg-[var(--color-primary)] transition-colors" />
					</div>

					<div
						className="shrink-0 border border-[var(--color-border)] rounded-lg overflow-hidden flex flex-col"
						style={{ height: responsePanelHeight }}
					>
						{/* Response toolbar */}
						<div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)] shrink-0">
							<div className="flex items-center gap-3">
								{/* Body / Headers tabs */}
								<div className="flex">
									{(["headers", "body"] as const).map((tab) => (
										<button
											type="button"
											key={tab}
											onClick={() => setResponseTab(tab)}
											className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
												responseTab === tab
													? "text-[var(--color-text-primary)] bg-[var(--color-bg-primary)]"
													: "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
											}`}
										>
											{t(`apiExplorer:response.${tab}`)}
										</button>
									))}
								</div>
								{/* Format selector — only when viewing body with content */}
								{responseTab === "body" && responseBody && (
									<div className="flex items-center gap-1 border-l border-[var(--color-border)] pl-3">
										{/* Segmented control wrapper */}
										<div className="flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-0.5 gap-0.5">
											{/* "Formaté" + language dropdown grouped */}
											<div
												className={`flex items-center rounded transition-colors ${
													responseFormat === "pretty"
														? "bg-[var(--color-bg-primary)] shadow-sm"
														: "hover:bg-[var(--color-bg-secondary)]"
												}`}
											>
												<button
													type="button"
													onClick={() => setResponseFormat("pretty")}
													className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
														responseFormat === "pretty"
															? "text-[var(--color-text-primary)]"
															: "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
													}`}
												>
													{t("apiExplorer:response.format.pretty")}
												</button>
												<LangDropdown
													value={responseLanguage}
													onChange={setResponseLanguage}
													t={t}
													active={responseFormat === "pretty"}
													onActivate={() => setResponseFormat("pretty")}
												/>
											</div>
											{/* "Brut" */}
											<button
												type="button"
												onClick={() => setResponseFormat("raw")}
												className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
													responseFormat === "raw"
														? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
														: "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
												}`}
											>
												{t("apiExplorer:response.format.raw")}
											</button>
											{/* "Aperçu" — only for HTML responses */}
											{detectContentType(responseHeaders).includes(
												"text/html",
											) && (
												<button
													type="button"
													onClick={() => setResponseFormat("preview")}
													className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
														responseFormat === "preview"
															? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
															: "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
													}`}
												>
													{t("apiExplorer:response.format.preview")}
												</button>
											)}
										</div>
									</div>
								)}
								{responseStatus !== null && (
									<div className="flex items-center gap-2 text-xs">
										<span
											className={`font-mono font-bold ${getStatusColor(responseStatus)}`}
										>
											{responseStatus} {responseStatusText}
										</span>
										{responseTime !== null && (
											<span className="text-[var(--color-text-muted)]">
												{responseTime}ms
											</span>
										)}
										{responseBody && (
											<span className="text-[var(--color-text-muted)]">
												{(
													new TextEncoder().encode(responseBody).length / 1024
												).toFixed(1)}{" "}
												KB
											</span>
										)}
									</div>
								)}
							</div>
							<div className="flex items-center gap-2">
								{extractedToken && (
									<button
										type="button"
										onClick={saveTokenToEnv}
										title={t("apiExplorer:response.saveTokenTitle")}
										className={`flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border transition-colors ${
											savedToken
												? "text-emerald-400 border-emerald-500/40 bg-emerald-400/10"
												: "text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)]/40"
										}`}
									>
										{savedToken ? <Check size={11} /> : <Shield size={11} />}
										{savedToken
											? t("apiExplorer:response.tokenSaved")
											: t("apiExplorer:response.saveToken")}
									</button>
								)}
								{responseBody && (
									<button
										type="button"
										onClick={copyResponse}
										className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
									>
										{copiedResponse ? (
											<Check size={13} className="text-emerald-400" />
										) : (
											<Copy size={13} />
										)}
									</button>
								)}
							</div>
						</div>

						{/* Response content — fills remaining height */}
						<div className="flex-1 min-h-0 overflow-auto">
							{isSendingRequest && !responseBody ? (
								<div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] h-full justify-center">
									<Loader2 size={15} className="animate-spin" />
									{t("apiExplorer:request.sending")}
								</div>
							) : responseTab === "body" ? (
								responseFormat === "preview" ? (
									<iframe
										srcDoc={responseBody}
										sandbox=""
										title={t("apiExplorer:response.format.preview")}
										className="w-full h-full border-0"
										style={{ background: "#fff" }}
									/>
								) : (
									<div className="p-3">
										{responseFormat === "raw" ? (
											<pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-all">
												{responseBody}
											</pre>
										) : (
											/* pretty */
											(() => {
												const ct = detectContentType(responseHeaders);
												const effectiveLang =
													responseLanguage !== "auto"
														? responseLanguage
														: ct.includes("xml") || ct.includes("svg")
															? "xml"
															: ct.includes("text/html")
																? "html"
																: ct.includes("json")
																	? "json"
																	: "text";

												if (
													effectiveLang === "xml" ||
													effectiveLang === "html"
												) {
													const isXmlLike = responseBody
														.trimStart()
														.startsWith("<");
													return (
														<>
															{!isXmlLike && responseLanguage !== "auto" && (
																<p className="mb-2 text-[11px] text-amber-400">
																	{t("apiExplorer:response.format.mismatch", {
																		format: effectiveLang.toUpperCase(),
																	})}
																</p>
															)}
															<pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-all">
																{isXmlLike
																	? prettifyXml(responseBody)
																	: responseBody}
															</pre>
														</>
													);
												}
												if (effectiveLang === "text") {
													return (
														<pre className="text-xs font-mono text-[var(--color-text-primary)] whitespace-pre-wrap break-all">
															{responseBody}
														</pre>
													);
												}
												// JSON
												let isValidJson = true;
												try {
													JSON.parse(responseBody);
												} catch {
													isValidJson = false;
												}
												return (
													<>
														{!isValidJson && responseLanguage !== "auto" && (
															<p className="mb-2 text-[11px] text-amber-400">
																{t("apiExplorer:response.format.mismatch", {
																	format: "JSON",
																})}
															</p>
														)}
														<pre
															className="text-xs font-mono whitespace-pre-wrap break-all"
															// biome-ignore lint/security/noDangerouslySetInnerHtml: content is HTML-escaped before highlighting
															dangerouslySetInnerHTML={{
																__html: isValidJson
																	? syntaxHighlightJson(responseBody)
																	: escapeHtml(responseBody),
															}}
														/>
													</>
												);
											})()
										)}
									</div>
								)
							) : (
								<div className="p-3 space-y-1">
									{Object.entries(responseHeaders).map(([k, v]) => (
										<div key={k} className="flex gap-2 text-xs">
											<span className="font-mono text-[var(--color-text-muted)] shrink-0">
												{k}:
											</span>
											<span className="font-mono text-[var(--color-text-primary)] break-all">
												{v}
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}

// ── Compact language dropdown for the response toolbar ───────────────────────
export const LANG_OPTIONS = ["auto", "json", "xml", "html", "text"] as const;

export type ResponseLanguage = (typeof LANG_OPTIONS)[number];

export interface LangDropdownProps {
	value: ResponseLanguage;
	onChange: (v: ResponseLanguage) => void;
	t: (key: string) => string;
	active?: boolean;
	onActivate?: () => void;
}

export function LangDropdown({
	value,
	onChange,
	t,
	active = true,
	onActivate,
}: LangDropdownProps) {
	const [open, setOpen] = useState(false);
	const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
	const btnRef = useRef<HTMLButtonElement>(null);
	const portalRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function handler(e: MouseEvent) {
			const target = e.target as Node;
			if (btnRef.current?.closest("[data-lang-dropdown]")?.contains(target))
				return;
			if (portalRef.current?.contains(target)) return;
			setOpen(false);
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	function handleOpen() {
		onActivate?.();
		if (btnRef.current) {
			const rect = btnRef.current.getBoundingClientRect();
			setDropdownPos({ top: rect.bottom + 4, left: rect.left });
		}
		setOpen((v) => !v);
	}

	return (
		<div className="relative" data-lang-dropdown="">
			<button
				ref={btnRef}
				type="button"
				onClick={handleOpen}
				className={`flex items-center gap-0.5 pl-0 pr-1.5 py-1 text-[11px] transition-colors cursor-pointer ${
					active
						? "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
						: "text-[var(--color-text-muted)]/60 hover:text-[var(--color-text-muted)]"
				}`}
			>
				{t(`apiExplorer:response.format.lang.${value}`)}
				<ChevronDown
					size={10}
					className={`transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open &&
				createPortal(
					<div
						ref={portalRef}
						data-lang-dropdown=""
						className="fixed min-w-[80px] border border-[var(--color-border)] rounded-md shadow-2xl overflow-hidden"
						style={{
							top: dropdownPos.top,
							left: dropdownPos.left,
							zIndex: 2147483647,
							backgroundColor: "var(--card, var(--color-bg-secondary))",
							isolation: "isolate",
						}}
					>
						{LANG_OPTIONS.map((lang) => (
							<button
								key={lang}
								type="button"
								onClick={() => {
									onChange(lang);
									setOpen(false);
								}}
								className={`flex items-center gap-1.5 w-full px-2.5 py-1.5 text-[11px] text-left transition-colors hover:bg-(--color-bg-secondary) ${
									lang === value
										? "text-[var(--color-primary)]"
										: "text-[var(--color-text-secondary)]"
								}`}
							>
								{lang === value && <Check size={10} className="shrink-0" />}
								{lang !== value && <span className="w-[10px] shrink-0" />}
								{t(`apiExplorer:response.format.lang.${lang}`)}
							</button>
						))}
					</div>,
					document.body,
				)}
		</div>
	);
}

export interface CustomSelectOption {
	value: string;
	label: string;
}

export interface CustomSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: CustomSelectOption[];
	className?: string;
}

export function CustomSelect({
	value,
	onChange,
	options,
	className,
}: CustomSelectProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const selected = options.find((o) => o.value === value);

	useEffect(() => {
		if (!open) return;
		function handler(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			)
				setOpen(false);
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={containerRef} className={`relative ${className ?? ""}`}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center justify-between w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-3 py-2 text-[length:inherit] text-[var(--color-text-primary)] hover:border-[var(--color-border-hover)] focus:outline-none focus:border-[var(--color-accent)] cursor-pointer transition-colors"
			>
				<span>{selected?.label ?? value}</span>
				<ChevronDown
					size={14}
					className={`text-[var(--color-text-muted)] shrink-0 ml-2 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open && (
				<div
					className="absolute z-50 top-full left-0 min-w-full w-max mt-1 bg-[var(--card)] border border-[var(--color-border)] rounded-md shadow-xl overflow-hidden"
					style={{ backdropFilter: "none" }}
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							className={`flex items-center gap-2 w-full px-3 py-2 text-[length:inherit] text-left transition-colors hover:bg-[var(--color-bg-secondary)] ${
								opt.value === value
									? "text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)]"
									: "text-[var(--color-text-secondary)]"
							}`}
						>
							{opt.value === value && (
								<Check
									size={13}
									className="shrink-0 text-[var(--color-primary)]"
								/>
							)}
							{opt.value !== value && <span className="w-[13px] shrink-0" />}
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export interface KVRow {
	id: string;
	enabled: boolean;
	key: string;
	value: string;
}

export type CustomRowField = "key" | "value" | "enabled";

export type CustomRowValue = string | boolean;

export interface KeyValueEditorProps {
	rows: KVRow[];
	onAdd: () => void;
	onUpdate: (id: string, field: CustomRowField, val: CustomRowValue) => void;
	onRemove: (id: string) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	addLabel: string;
}

export function KeyValueEditor({
	rows,
	onAdd,
	onUpdate,
	onRemove,
	keyPlaceholder = "Key",
	valuePlaceholder = "Value",
	addLabel,
}: KeyValueEditorProps) {
	return (
		<div className="space-y-1.5">
			{rows.map((row) => (
				<div key={row.id} className="flex items-center gap-1.5">
					<input
						type="checkbox"
						checked={row.enabled}
						onChange={(e) => onUpdate(row.id, "enabled", e.target.checked)}
						className="w-3.5 h-3.5 shrink-0 accent-[var(--color-primary)] cursor-pointer"
					/>
					<input
						className="flex-1 min-w-0 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
						value={row.key}
						onChange={(e) => onUpdate(row.id, "key", e.target.value)}
						placeholder={keyPlaceholder}
					/>
					<input
						className="flex-1 min-w-0 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs font-mono text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
						value={row.value}
						onChange={(e) => onUpdate(row.id, "value", e.target.value)}
						placeholder={valuePlaceholder}
					/>
					<button
						type="button"
						onClick={() => onRemove(row.id)}
						className="shrink-0 p-1 text-[var(--color-text-muted)] hover:text-red-400 transition-colors"
					>
						<Trash2 size={13} />
					</button>
				</div>
			))}
			<button
				type="button"
				onClick={onAdd}
				className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors py-1"
			>
				<Plus size={13} />
				{addLabel}
			</button>
		</div>
	);
}

export function ParamRow({
	param,
	value,
	onChange,
}: {
	param: OpenApiParameter;
	value: string;
	onChange: (v: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 mb-1.5">
			<div className="w-32 shrink-0">
				<span className="text-xs font-mono text-[var(--color-text-secondary)]">
					{param.name}
				</span>
				{param.required && <span className="text-red-400 ml-0.5">*</span>}
			</div>
			<input
				className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={
					param.example ? String(param.example) : (param.description ?? "")
				}
			/>
		</div>
	);
}

export function getBodyPlaceholder(
	operation: OpenApiOperation,
	spec: OpenApiSpec,
): string {
	if (!operation.requestBody) return "{}";
	const content = operation.requestBody.content ?? {};
	const jsonContent = content["application/json"];
	if (!jsonContent) return "{}";

	if (jsonContent.example) {
		return JSON.stringify(jsonContent.example, null, 2);
	}

	if (jsonContent.schema) {
		const schema = jsonContent.schema.$ref
			? (resolveRef(jsonContent.schema.$ref, spec) ?? jsonContent.schema)
			: jsonContent.schema;

		if (schema.example) return JSON.stringify(schema.example, null, 2);

		// Build example from schema
		const example = buildExampleFromSchema(
			schema as Record<string, unknown>,
			spec,
			0,
		);
		return JSON.stringify(example, null, 2);
	}

	return "{}";
}

export function buildExampleFromSchema(
	schema: Record<string, unknown>,
	spec: OpenApiSpec,
	depth: number,
): unknown {
	if (depth > 3) return null;
	const resolved =
		schema.$ref && typeof schema.$ref === "string"
			? (resolveRef(schema.$ref, spec) ?? schema)
			: schema;

	const type = resolved.type as string | undefined;
	const properties = resolved.properties as
		| Record<string, Record<string, unknown>>
		| undefined;
	const items = resolved.items as Record<string, unknown> | undefined;
	const example = resolved.example;

	if (example !== undefined) return example;

	if (type === "object" || (!type && properties)) {
		const obj: Record<string, unknown> = {};
		for (const [key, prop] of Object.entries(properties ?? {})) {
			obj[key] = buildExampleFromSchema(prop, spec, depth + 1);
		}
		return obj;
	}
	if (type === "array")
		return items ? [buildExampleFromSchema(items, spec, depth + 1)] : [];
	if (type === "string") return (resolved.enum as string[])?.[0] ?? "string";
	if (type === "number" || type === "integer") return 0;
	if (type === "boolean") return true;
	return null;
}
