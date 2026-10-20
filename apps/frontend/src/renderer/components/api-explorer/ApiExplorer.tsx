import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Download,
	ExternalLink,
	Globe,
	Loader2,
	Play,
	RefreshCw,
	ScanSearch,
	Search,
	Settings,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import { useProjectRouteScan } from "../../hooks/useProjectRouteScan";
import {
	makeEndpointKey,
	type OpenApiOperation,
	type OpenApiSpec,
	useApiExplorerStore,
} from "../../stores/api-explorer-store";
import {
	openAppEmulatorDialog,
	useAppEmulatorStore,
} from "../../stores/app-emulator-store";
import { useProjectStore } from "../../stores/project-store";
import { MethodBadge } from "./api-explorer-shared";
import { EnvironmentManager } from "./EnvironmentManager";
import { ExportDialog } from "./ExportDialog";
import { RequestPanel, CustomSelect } from "./RequestPanel";

// ── Endpoint Detail ──────────────────────────────────────────────────────────

interface EndpointDetailProps {
	method: string;
	path: string;
	operation: OpenApiOperation;
	spec: OpenApiSpec;
	onOpenEnvManager: () => void;
}
function EndpointDetail({
	method,
	path,
	operation,
	spec,
	onOpenEnvManager,
}: EndpointDetailProps) {
	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header */}
			<div className="px-5 pt-4 pb-3 shrink-0 border-b border-[var(--color-border)]">
				<div className="flex items-start gap-2.5">
					<MethodBadge method={method} size="md" />
					<div className="flex-1 min-w-0">
						<code className="text-sm font-mono text-[var(--color-text-primary)] break-all">
							{path}
						</code>
						{operation.summary && (
							<div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
								{operation.summary}
							</div>
						)}
					</div>
					{operation.deprecated && (
						<span className="text-[10px] font-mono border border-amber-400/30 text-amber-400 bg-amber-400/10 rounded px-1.5 py-0.5 shrink-0">
							deprecated
						</span>
					)}
				</div>
			</div>

			{/* Request builder — always visible, like Postman */}
			<div className="flex-1 overflow-hidden">
				<RequestPanel
					method={method}
					path={path}
					operation={operation}
					spec={spec}
					onOpenEnvManager={onOpenEnvManager}
				/>
			</div>
		</div>
	);
}

// ── Endpoint List ────────────────────────────────────────────────────────────

interface EndpointGroup {
	tag: string;
	tagDescription?: string;
	endpoints: Array<{ method: string; path: string; op: OpenApiOperation }>;
}

function buildGroups(spec: OpenApiSpec, search: string): EndpointGroup[] {
	const tagMap: Record<string, EndpointGroup> = {};
	const tagOrder: string[] = spec.tags?.map((t) => t.name) ?? [];

	for (const [path, methods] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(methods)) {
			if (
				!["get", "post", "put", "delete", "patch", "head", "options"].includes(
					method,
				)
			)
				continue;

			const searchLower = search.toLowerCase();
			if (
				search &&
				!path.toLowerCase().includes(searchLower) &&
				!op.summary?.toLowerCase().includes(searchLower) &&
				!op.operationId?.toLowerCase().includes(searchLower)
			) {
				continue;
			}

			const tags = op.tags?.length ? op.tags : ["default"];
			for (const tag of tags) {
				if (!tagMap[tag]) {
					const tagMeta = spec.tags?.find((t) => t.name === tag);
					tagMap[tag] = {
						tag,
						tagDescription: tagMeta?.description,
						endpoints: [],
					};
					if (!tagOrder.includes(tag)) tagOrder.push(tag);
				}
				tagMap[tag].endpoints.push({ method, path, op });
			}
		}
	}

	return tagOrder.filter((t) => tagMap[t]).map((t) => tagMap[t]);
}

// ── Main ApiExplorer Component ───────────────────────────────────────────────

export function ApiExplorer() {
	const { t } = useTranslation(["apiExplorer"]);

	const spec = useApiExplorerStore((s) => s.spec);
	const specUrl = useApiExplorerStore((s) => s.specUrl);
	const isLoadingSpec = useApiExplorerStore((s) => s.isLoadingSpec);
	const specError = useApiExplorerStore((s) => s.specError);
	const specSource = useApiExplorerStore((s) => s.specSource);
	const specFilePath = useApiExplorerStore((s) => s.specFilePath);
	const scannedApiProjects = useApiExplorerStore((s) => s.scannedApiProjects);
	const isProjectScanning = useApiExplorerStore((s) => s.isProjectScanning);
	const projectScanError = useApiExplorerStore((s) => s.projectScanError);
	const lastProjectScanAt = useApiExplorerStore((s) => s.lastProjectScanAt);
	const environments = useApiExplorerStore((s) => s.environments);
	const activeEnvironmentId = useApiExplorerStore((s) => s.activeEnvironmentId);
	const selectedEndpointKey = useApiExplorerStore((s) => s.selectedEndpointKey);
	const searchQuery = useApiExplorerStore((s) => s.searchQuery);
	const collapsedTags = useApiExplorerStore((s) => s.collapsedTags);

	const setSpec = useApiExplorerStore((s) => s.setSpec);
	const setSpecUrl = useApiExplorerStore((s) => s.setSpecUrl);
	const setSpecSource = useApiExplorerStore((s) => s.setSpecSource);
	const setIsLoadingSpec = useApiExplorerStore((s) => s.setIsLoadingSpec);
	const setSpecError = useApiExplorerStore((s) => s.setSpecError);
	const setScannedProjectId = useApiExplorerStore(
		(s) => s.setScannedProjectId,
	);
	const setActiveEnvironment = useApiExplorerStore(
		(s) => s.setActiveEnvironment,
	);
	const setSelectedEndpointKey = useApiExplorerStore(
		(s) => s.setSelectedEndpointKey,
	);
	const setSearchQuery = useApiExplorerStore((s) => s.setSearchQuery);
	const toggleTag = useApiExplorerStore((s) => s.toggleTag);

	const [showEnvManager, setShowEnvManager] = useState(false);
	const [showExport, setShowExport] = useState(false);
	const [urlInput, setUrlInput] = useState(specUrl);
	useEffect(() => setUrlInput(specUrl), [specUrl]);

	// Background scan hook — rescan() forces a new scan of the active project
	const { rescan } = useProjectRouteScan();

	const activeEnv =
		environments.find((e) => e.id === activeEnvironmentId) ?? environments[0];

	// App Emulator integration
	const emulatorPhase = useAppEmulatorStore((s) => s.phase);
	const emulatorUrl = useAppEmulatorStore((s) => s.url);
	const emulatorStatus = useAppEmulatorStore((s) => s.status);
	const updateEnvironment = useApiExplorerStore((s) => s.updateEnvironment);
	const activeProjectId = useProjectStore((s) => s.activeProjectId);
	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
	const currentProjectId = activeProjectId ?? selectedProjectId;
	const activeEnvironmentKey = activeEnv?.id;
	const environmentSecretScope =
		currentProjectId && activeEnvironmentKey
			? `environment:${currentProjectId}:${activeEnvironmentKey}`
			: null;
	const loadedEnvironmentSecretScope = useRef<string | null>(null);

	useEffect(() => {
		if (!environmentSecretScope || !activeEnvironmentKey) return;
		let cancelled = false;
		loadedEnvironmentSecretScope.current = null;
		updateEnvironment(activeEnvironmentKey, { token: "" });
		void globalThis.electronAPI
			.loadApiExplorerSecrets(environmentSecretScope)
			.then((result) => {
				if (cancelled) return;
				if (result.success && result.data) {
					updateEnvironment(activeEnvironmentKey, {
						token: result.data.environmentToken ?? "",
					});
				}
				loadedEnvironmentSecretScope.current = environmentSecretScope;
			});
		return () => {
			cancelled = true;
		};
	}, [environmentSecretScope, activeEnvironmentKey, updateEnvironment]);

	useEffect(() => {
		if (
			!environmentSecretScope ||
			loadedEnvironmentSecretScope.current !== environmentSecretScope
		)
			return;
		void globalThis.electronAPI.saveApiExplorerSecrets(
			environmentSecretScope,
			{ environmentToken: activeEnv?.token ?? "" },
		);
	}, [environmentSecretScope, activeEnv?.token]);

	// When emulator becomes running, auto-sync active environment base URL
	const prevEmulatorPhase = useRef(emulatorPhase);
	useEffect(() => {
		if (
			emulatorPhase === "running" &&
			emulatorUrl &&
			prevEmulatorPhase.current !== "running"
		) {
			if (activeEnv) {
				updateEnvironment(activeEnv.id, { baseUrl: emulatorUrl });
			}
		}
		prevEmulatorPhase.current = emulatorPhase;
	}, [emulatorPhase, emulatorUrl, activeEnv, updateEnvironment]);

	function handleEmulatorToggle() {
		// Always open the dialog — stop is handled inside the dialog
		openAppEmulatorDialog();
	}

	// Load spec from a remote OpenAPI URL (via main process proxy to bypass CSP)
	const loadSpec = useCallback(
		async (url: string) => {
			setIsLoadingSpec(true);
			setSpecError(null);
			try {
				const result = await globalThis.electronAPI.proxyHttpRequest({
					url,
					method: "GET",
					headers: { Accept: "application/json" },
				});
				if (!result.success || !result.status || result.status >= 400) {
					throw new Error(
						`HTTP ${result.status ?? 0}: ${result.statusText ?? "Error"}`,
					);
				}
				const data: OpenApiSpec = JSON.parse(result.body ?? "");
				setSpec(data);
				setSpecSource("url");
				const projectState = useProjectStore.getState();
				setScannedProjectId(
					projectState.activeProjectId ?? projectState.selectedProjectId,
				);
			} catch (err) {
				setSpecError(String(err));
				if (useApiExplorerStore.getState().specSource !== "scan") {
					setSpec(null);
				}
			} finally {
				setIsLoadingSpec(false);
			}
		},
		[
			setIsLoadingSpec,
			setSpecError,
			setSpec,
			setSpecSource,
			setScannedProjectId,
		],
	);

	function applySpecUrl() {
		if (urlInput !== specUrl) {
			setSpecUrl(urlInput);
		}
		void loadSpec(urlInput);
	}

	const groups = useMemo(
		() => (spec ? buildGroups(spec, searchQuery) : []),
		[spec, searchQuery],
	);

	const totalEndpoints = useMemo(
		() => groups.reduce((acc, g) => acc + g.endpoints.length, 0),
		[groups],
	);

	// Find the selected endpoint
	const selectedEndpoint = useMemo(() => {
		if (!selectedEndpointKey || !spec) return null;
		const [method, ...pathParts] = selectedEndpointKey.split(":");
		const path = pathParts.join(":");
		const op = spec.paths?.[path]?.[method.toLowerCase()];
		if (!op) return null;
		return { method, path, op };
	}, [selectedEndpointKey, spec]);

	function selectEndpoint(method: string, path: string) {
		setSelectedEndpointKey(makeEndpointKey(method, path));
	}

	// Emulator button derived values (avoids nested ternaries in JSX)
	const isEmulatorBusy =
		emulatorPhase === "detecting" || emulatorPhase === "starting";
	const isEmulatorRunning = emulatorPhase === "running";
	const emulatorBtnClass = isEmulatorRunning
		? "shrink-0 gap-1.5 border-emerald-500/50 text-emerald-400 hover:bg-emerald-400/10"
		: "shrink-0 gap-1.5";
	const emulatorBtnTitle = isEmulatorRunning
		? emulatorStatus || emulatorUrl || ""
		: t("apiExplorer:emulator.run");
	let emulatorBtnLabel = t("apiExplorer:emulator.run");
	if (emulatorPhase === "detecting")
		emulatorBtnLabel = t("apiExplorer:emulator.detecting");
	else if (emulatorPhase === "starting")
		emulatorBtnLabel = t("apiExplorer:emulator.starting");
	else if (isEmulatorRunning)
		emulatorBtnLabel = t("apiExplorer:emulator.running");

	return (
		<div className="flex flex-col h-full bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
			{/* Top bar */}
			<div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] shrink-0 bg-[var(--color-bg-primary)]">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<Globe
						size={16}
						className="text-[var(--color-text-muted)] shrink-0"
					/>
					<input
						className="flex-1 min-w-0 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
						value={urlInput}
						onChange={(e) => setUrlInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && applySpecUrl()}
						placeholder="http://127.0.0.1:9000/openapi.json"
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={applySpecUrl}
						disabled={isLoadingSpec}
						className="shrink-0"
					>
						{isLoadingSpec ? (
							<Loader2 size={13} className="animate-spin" />
						) : (
							<RefreshCw size={13} />
						)}
					</Button>

					<Button
						size="sm"
						variant="outline"
						onClick={rescan}
						disabled={isProjectScanning}
						className="shrink-0 gap-1.5"
						title={t("apiExplorer:scan.tooltip")}
					>
						{isProjectScanning ? (
							<Loader2 size={13} className="animate-spin" />
						) : (
							<ScanSearch size={13} />
						)}
						<span className="text-[11px]">
							{isProjectScanning
								? t("apiExplorer:scan.scanning")
								: t("apiExplorer:scan.resync")}
						</span>
					</Button>

					{/* App Emulator toggle button */}
					<Button
						size="sm"
						variant="outline"
						onClick={handleEmulatorToggle}
						disabled={isEmulatorBusy}
						className={emulatorBtnClass}
						title={emulatorBtnTitle}
					>
						{isEmulatorBusy && <Loader2 size={13} className="animate-spin" />}
						{!isEmulatorBusy && <Play size={13} />}
						<span className="text-[11px]">{emulatorBtnLabel}</span>
						{isEmulatorRunning && (
							<span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
						)}
					</Button>
				</div>

				{/* Environment selector */}
				<div className="flex items-center gap-1 shrink-0">
					<CustomSelect
						value={activeEnvironmentId}
						onChange={setActiveEnvironment}
						options={[
							{ value: "", label: t("apiExplorer:environments.placeholder") },
							...environments.map((env) => ({
								value: env.id,
								label: env.name,
							})),
						]}
						className="max-w-36 text-xs"
					/>
					<button
						type="button"
						onClick={() => setShowEnvManager(true)}
						className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
						title={t("apiExplorer:environments.manage")}
					>
						<Settings size={14} />
					</button>
				</div>

				{/* Export */}
				{spec && (
					<button
						type="button"
						onClick={() => setShowExport(true)}
						className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md transition-colors shrink-0"
					>
						<Download size={13} />
						{t("apiExplorer:actions.export")}
					</button>
				)}
			</div>

			{/* Main layout */}
			<div className="flex flex-1 min-h-0">
				{/* Sidebar */}
				<div className="w-64 shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-primary)]">
					{/* Spec info + scan status + search */}
					<div className="p-3 border-b border-[var(--color-border)]">
						{/* Scan status banner */}
						{isProjectScanning && (
							<div className="flex items-center gap-1.5 mb-2 text-[10px] text-[var(--color-text-muted)]">
								<Loader2 size={10} className="animate-spin shrink-0" />
								<span>{t("apiExplorer:scan.scanning")}</span>
							</div>
						)}

						{/* Project scan error */}
						{projectScanError && !isProjectScanning && (
							<div className="flex items-start gap-1.5 mb-2 p-2 bg-amber-400/10 border border-amber-400/20 rounded-md">
								<AlertCircle
									size={11}
									className="text-amber-400 shrink-0 mt-0.5"
								/>
								<span className="text-[10px] text-amber-400/80 break-all">
									{projectScanError}
								</span>
							</div>
						)}

						{spec && (
							<div className="mb-2.5">
								<div className="flex items-center gap-2 mb-0.5">
									<div className="text-sm font-semibold text-[var(--color-text-primary)] truncate flex-1">
										{spec.info.title}
									</div>
									{/* Source badge */}
									{specSource === "scan" && (
										<span className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-400 border border-emerald-400/20">
											{t("apiExplorer:scan.sourceBadge")}
										</span>
									)}
									{specSource === "file" && (
										<span
											className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded bg-violet-400/10 text-violet-400 border border-violet-400/20"
											title={specFilePath ?? undefined}
										>
											{t("apiExplorer:scan.fileBadge")}
										</span>
									)}
									{specSource === "url" && (
										<span className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-400 border border-blue-400/20">
											URL
										</span>
									)}
								</div>
								<div className="text-[10px] text-[var(--color-text-muted)] font-mono">
									v{spec.info.version} · {totalEndpoints}{" "}
									{t("apiExplorer:sidebar.endpoints")}
									{specSource === "file" && specFilePath && (
										<span className="ml-1 opacity-60">· {specFilePath}</span>
									)}
									{specSource === "scan" && scannedApiProjects.length > 0 && (
										<span
											className="ml-1 opacity-60"
											title={scannedApiProjects.join(", ")}
										>
											· {scannedApiProjects.join(", ")}
										</span>
									)}
									{specSource === "scan" && lastProjectScanAt && (
										<span className="ml-1 opacity-60">
											·{" "}
											{t("apiExplorer:scan.scannedAt", {
												time: new Date(lastProjectScanAt).toLocaleTimeString(
													[],
													{ hour: "2-digit", minute: "2-digit" },
												),
											})}
										</span>
									)}
								</div>
							</div>
						)}
						<div className="relative">
							<Search
								size={12}
								className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
							/>
							<input
								className="w-full pl-7 pr-2 py-1.5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder={t("apiExplorer:sidebar.search")}
							/>
							{searchQuery && (
								<button
									type="button"
									onClick={() => setSearchQuery("")}
									className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
								>
									<X size={11} />
								</button>
							)}
						</div>
					</div>

					{/* Endpoint list */}
					<div className="flex-1 overflow-y-auto">
						{isLoadingSpec && (
							<div className="flex items-center justify-center py-12 gap-2 text-sm text-[var(--color-text-muted)]">
								<Loader2 size={15} className="animate-spin" />
								{t("apiExplorer:sidebar.loading")}
							</div>
						)}

						{specError && (
							<div className="p-3">
								<div className="flex items-start gap-2 p-3 bg-red-400/10 border border-red-400/20 rounded-lg">
									<AlertCircle
										size={14}
										className="text-red-400 shrink-0 mt-0.5"
									/>
									<div>
										<div className="text-xs font-medium text-red-400">
											{t("apiExplorer:sidebar.loadError")}
										</div>
										<div className="text-[10px] text-red-400/70 mt-1 font-mono break-all">
											{specError}
										</div>
									</div>
								</div>
							</div>
						)}

						{!isLoadingSpec && !specError && groups.length === 0 && spec && (
							<div className="text-xs text-[var(--color-text-muted)] text-center py-8">
								{t("apiExplorer:sidebar.noResults")}
							</div>
						)}

						{groups.map((group) => {
							const isCollapsed = collapsedTags.includes(group.tag);
							return (
								<div key={group.tag}>
									<button
										type="button"
										onClick={() => toggleTag(group.tag)}
										className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--color-bg-secondary)] transition-colors group"
									>
										<div className="flex items-center gap-1.5 min-w-0">
											{isCollapsed ? (
												<ChevronRight
													size={12}
													className="text-[var(--color-text-muted)] shrink-0"
												/>
											) : (
												<ChevronDown
													size={12}
													className="text-[var(--color-text-muted)] shrink-0"
												/>
											)}
											<span className="text-xs font-semibold text-[var(--color-text-secondary)] truncate">
												{group.tag}
											</span>
										</div>
										<span className="text-[10px] text-[var(--color-text-muted)] font-mono shrink-0 ml-1">
											{group.endpoints.length}
										</span>
									</button>

									{!isCollapsed && (
										<div>
											{group.endpoints.map(({ method, path, op }) => {
												const key = makeEndpointKey(method, path);
												const isSelected = selectedEndpointKey === key;
												const endpointTitle = op.summary
													? `${path} — ${op.summary}`
													: path;
												return (
													<button
														type="button"
														key={key}
														onClick={() => selectEndpoint(method, path)}
														className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors group ${
															isSelected
																? "bg-[var(--color-accent)]/10 border-r-2 border-[var(--color-accent)]"
																: "hover:bg-[var(--color-bg-secondary)]"
														}`}
													>
														<MethodBadge method={method} />
														<span
															className={`text-xs font-mono truncate flex-1 ${
																isSelected
																	? "text-[var(--color-text-primary)]"
																	: "text-[var(--color-text-secondary)]"
															}`}
															title={endpointTitle}
														>
															{path}
														</span>
													</button>
												);
											})}
										</div>
									)}
								</div>
							);
						})}
					</div>

					{/* Active env indicator */}
					{activeEnv && (
						<div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
							<div className="flex items-center gap-1.5">
								<div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
								<span className="text-[10px] font-mono text-[var(--color-text-muted)] truncate">
									{activeEnv.baseUrl}
								</span>
							</div>
						</div>
					)}
				</div>

				{/* Detail panel */}
				<div className="flex-1 min-w-0 overflow-hidden">
					{selectedEndpoint ? (
						<EndpointDetail
							method={selectedEndpoint.method}
							path={selectedEndpoint.path}
							operation={selectedEndpoint.op}
							// biome-ignore lint/style/noNonNullAssertion: value is guaranteed by context
							spec={spec!}
							onOpenEnvManager={() => setShowEnvManager(true)}
						/>
					) : (
						<EmptyState spec={spec} isLoading={isLoadingSpec} t={t} />
					)}
				</div>
			</div>

			{/* Dialogs */}
			{showEnvManager && (
				<EnvironmentManager onClose={() => setShowEnvManager(false)} />
			)}
			{showExport && spec && (
				<ExportDialog spec={spec} onClose={() => setShowExport(false)} />
			)}
		</div>
	);
}

function EmptyState({
	spec,
	isLoading,
	t,
}: {
	spec: OpenApiSpec | null;
	isLoading: boolean;
	t: (key: string) => string;
}) {
	if (isLoading) return null;
	return (
		<div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--color-text-muted)]">
			<div className="w-16 h-16 rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex items-center justify-center">
				<ExternalLink size={24} className="opacity-40" />
			</div>
			<div className="text-center">
				<div className="text-sm font-medium text-[var(--color-text-secondary)] mb-1">
					{spec
						? t("apiExplorer:empty.selectEndpoint")
						: t("apiExplorer:empty.noSpec")}
				</div>
				<div className="text-xs text-[var(--color-text-muted)]">
					{spec
						? t("apiExplorer:empty.selectEndpointHint")
						: t("apiExplorer:empty.noSpecHint")}
				</div>
			</div>
		</div>
	);
}
