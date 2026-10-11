/**
 * Environments of the API Explorer: detecting base URLs from the project's .env
 * files, and the dialog that lists, edits and selects them. Split out of
 * ApiExplorer.tsx (audit lot L11, F36).
 */

import { Loader2, Plus, ScanSearch, Settings, Trash2, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui";
import {
	type ApiEnvironment,
	useApiExplorerStore,
} from "../../stores/api-explorer-store";
import { useProjectStore } from "../../stores/project-store";

// ── Environment Auto-Detection ───────────────────────────────────────────────

export interface DetectedEnvironment {
	name: string;
	baseUrl: string;
	headers: Record<string, string>;
	source: string; // file origin
}

/** Parse a .env file content into key=value pairs */
export function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		// Strip surrounding quotes
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		result[key] = val;
	}
	return result;
}

/** Return true if value looks like an HTTP(S) URL */
export function isUrl(val: string): boolean {
	return /^https?:\/\/[^\s]+/.test(val);
}

/** Pick the most relevant URL from a parsed env object */
export function pickBestUrl(vars: Record<string, string>): string | null {
	// Priority: known keys first
	const priority = [
		"VITE_BACKEND_URL",
		"BACKEND_URL",
		"API_URL",
		"API_BASE_URL",
		"REACT_APP_API_URL",
		"NEXT_PUBLIC_API_URL",
		"APP_URL",
		"BASE_URL",
	];
	for (const key of priority) {
		if (vars[key] && isUrl(vars[key])) return vars[key];
	}
	// Fallback: any key ending in _URL, _BASE_URL, _API_URL, _ENDPOINT that looks like URL
	const urlPatterns = [
		/_URL$/,
		/_BASE_URL$/,
		/_API_URL$/,
		/_ENDPOINT$/,
		/_HOST$/,
	];
	for (const [key, val] of Object.entries(vars)) {
		if (urlPatterns.some((p) => p.test(key)) && isUrl(val)) return val;
	}
	return null;
}

/** Derive a human-readable env name from a filename */
export function envNameFromFile(filename: string): string {
	const base = filename.replace(/^\.env\.?/, "").replace(/^\./, "");
	if (!base) return "Default";
	return base.charAt(0).toUpperCase() + base.slice(1);
}

export async function detectEnvironmentsFromProject(
	projectPath: string,
): Promise<DetectedEnvironment[]> {
	const filesToScan = [
		".env",
		".env.local",
		".env.development",
		".env.staging",
		".env.stage",
		".env.production",
		".env.prod",
		".env.test",
		"apps/frontend/.env",
		"apps/frontend/.env.local",
		"apps/frontend/.env.staging",
		"apps/frontend/.env.production",
	];

	const detected: DetectedEnvironment[] = [];
	const seenUrls = new Set<string>();

	for (const relPath of filesToScan) {
		const fullPath = `${projectPath}/${relPath}`.replaceAll("\\", "/");
		try {
			const result = await globalThis.electronAPI.readFile(fullPath);
			if (!result.success || !result.data) continue;

			const vars = parseEnvFile(result.data);
			const url = pickBestUrl(vars);
			if (!url || seenUrls.has(url)) continue;

			seenUrls.add(url);
			const filename = relPath.split("/").pop() ?? relPath;
			detected.push({
				name: envNameFromFile(filename),
				baseUrl: url,
				headers: {},
				source: relPath,
			});
		} catch {
			// File doesn't exist — skip silently
		}
	}

	return detected;
}

// ── Environment Manager Dialog ───────────────────────────────────────────────

export interface EnvironmentManagerProps {
	readonly onClose: () => void;
}

export function EnvironmentManager({ onClose }: EnvironmentManagerProps) {
	const { t } = useTranslation(["apiExplorer"]);
	const environments = useApiExplorerStore((s) => s.environments);
	const addEnvironment = useApiExplorerStore((s) => s.addEnvironment);
	const updateEnvironment = useApiExplorerStore((s) => s.updateEnvironment);
	const removeEnvironment = useApiExplorerStore((s) => s.removeEnvironment);

	// Project path for auto-detection
	const projects = useProjectStore((s) => s.projects);
	const activeProjectId = useProjectStore((s) => s.activeProjectId);
	const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
	const activeProject = projects.find(
		(p) => p.id === (activeProjectId ?? selectedProjectId),
	);

	const [editId, setEditId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editUrl, setEditUrl] = useState("");
	const [editHeaders, setEditHeaders] = useState("");
	const [editToken, setEditToken] = useState("");
	const [editTokenVisible, setEditTokenVisible] = useState(false);
	const [isAdding, setIsAdding] = useState(false);
	const [newName, setNewName] = useState("");
	const [newUrl, setNewUrl] = useState("");
	const [newHeaders, setNewHeaders] = useState("");
	const [newToken, setNewToken] = useState("");
	const [newTokenVisible, setNewTokenVisible] = useState(false);

	// Auto-detection state
	const [isDetecting, setIsDetecting] = useState(false);
	const [detectedEnvs, setDetectedEnvs] = useState<DetectedEnvironment[]>([]);
	const [selectedDetected, setSelectedDetected] = useState<Set<number>>(
		new Set(),
	);

	async function runDetection() {
		if (!activeProject?.path) return;
		setIsDetecting(true);
		setDetectedEnvs([]);
		try {
			const results = await detectEnvironmentsFromProject(activeProject.path);
			// Filter out URLs already in the list
			const existingUrls = new Set(environments.map((e) => e.baseUrl));
			const fresh = results.filter((r) => !existingUrls.has(r.baseUrl));
			setDetectedEnvs(fresh);
			setSelectedDetected(new Set(fresh.map((_, i) => i)));
		} finally {
			setIsDetecting(false);
		}
	}

	function importDetected() {
		for (const idx of selectedDetected) {
			const env = detectedEnvs[idx];
			if (env)
				addEnvironment({
					name: env.name,
					baseUrl: env.baseUrl,
					headers: env.headers,
				});
		}
		setDetectedEnvs([]);
		setSelectedDetected(new Set());
	}

	function toggleDetected(idx: number) {
		setSelectedDetected((prev) => {
			const next = new Set(prev);
			next.has(idx) ? next.delete(idx) : next.add(idx);
			return next;
		});
	}

	function startEdit(env: ApiEnvironment) {
		setEditId(env.id);
		setEditName(env.name);
		setEditUrl(env.baseUrl);
		setEditToken(env.token ?? "");
		setEditTokenVisible(false);
		setEditHeaders(
			Object.entries(env.headers)
				.map(([k, v]) => `${k}: ${v}`)
				.join("\n"),
		);
	}

	function saveEdit() {
		if (!editId) return;
		const headers: Record<string, string> = {};
		for (const line of editHeaders.split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}
		updateEnvironment(editId, {
			name: editName,
			baseUrl: editUrl,
			headers,
			token: editToken || undefined,
		});
		setEditId(null);
	}

	function addNew() {
		const headers: Record<string, string> = {};
		for (const line of newHeaders.split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}
		addEnvironment({
			name: newName,
			baseUrl: newUrl,
			headers,
			token: newToken || undefined,
		});
		setIsAdding(false);
		setNewName("");
		setNewUrl("");
		setNewHeaders("");
		setNewToken("");
	}

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-xl p-6">
				<div className="flex items-center justify-between mb-5">
					<h2 className="text-base font-semibold text-[var(--color-text-primary)]">
						{t("apiExplorer:environments.title")}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
					>
						<X size={18} />
					</button>
				</div>

				<div className="space-y-3 max-h-80 overflow-y-auto pr-1">
					{environments.map((env) => (
						<div
							key={env.id}
							className="border border-[var(--color-border)] rounded-lg p-3"
						>
							{editId === env.id ? (
								<div className="space-y-2">
									<input
										className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text-primary)]"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										placeholder={t("apiExplorer:environments.namePlaceholder")}
									/>
									<input
										className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-sm font-mono text-[var(--color-text-primary)]"
										value={editUrl}
										onChange={(e) => setEditUrl(e.target.value)}
										placeholder="https://api.example.com"
									/>
									<div className="relative">
										<div className="text-[10px] text-[var(--color-text-muted)] mb-0.5">
											{t("apiExplorer:environments.token")}
										</div>
										<div className="flex gap-1">
											<input
												type={editTokenVisible ? "text" : "password"}
												className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)]"
												value={editToken}
												onChange={(e) => setEditToken(e.target.value)}
												placeholder={t(
													"apiExplorer:environments.tokenPlaceholder",
												)}
											/>
											<button
												type="button"
												onClick={() => setEditTokenVisible((v) => !v)}
												className="px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)] transition-colors"
											>
												{editTokenVisible ? "🙈" : "👁"}
											</button>
										</div>
									</div>
									<div className="text-[10px] text-[var(--color-text-muted)] mb-0.5">
										{t("apiExplorer:environments.headers")}
									</div>
									<textarea
										className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)] resize-none"
										rows={3}
										value={editHeaders}
										onChange={(e) => setEditHeaders(e.target.value)}
										placeholder="X-API-Key: key&#10;X-Custom: value"
									/>
									<div className="flex gap-2 justify-end">
										<Button
											size="sm"
											variant="outline"
											onClick={() => setEditId(null)}
										>
											{t("apiExplorer:actions.cancel")}
										</Button>
										<Button size="sm" onClick={saveEdit}>
											{t("apiExplorer:actions.save")}
										</Button>
									</div>
								</div>
							) : (
								<div className="flex items-center justify-between">
									<div>
										<div className="flex items-center gap-2">
											<div className="text-sm font-medium text-(--color-text-primary)">
												{env.name}
											</div>
											{env.token && (
												<span className="text-[9px] font-mono bg-amber-400/10 text-amber-400 border border-amber-400/20 rounded px-1 py-0.5">
													Bearer ••••
												</span>
											)}
										</div>
										<div className="text-xs font-mono text-[var(--color-text-muted)] mt-0.5">
											{env.baseUrl}
										</div>
									</div>
									<div className="flex items-center gap-1.5">
										<button
											type="button"
											onClick={() => startEdit(env)}
											className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] p-1 rounded transition-colors"
										>
											<Settings size={14} />
										</button>
										{!env.isDefault && (
											<button
												type="button"
												onClick={() => removeEnvironment(env.id)}
												className="text-[var(--color-text-muted)] hover:text-red-400 p-1 rounded transition-colors"
											>
												<Trash2 size={14} />
											</button>
										)}
									</div>
								</div>
							)}
						</div>
					))}
				</div>

				{/* Auto-detected environments */}
				{detectedEnvs.length > 0 && (
					<div className="mt-3 border border-emerald-400/20 bg-emerald-400/5 rounded-lg p-3">
						<div className="flex items-center justify-between mb-2.5">
							<span className="text-xs font-semibold text-emerald-400">
								{t("apiExplorer:environments.detected")} ({detectedEnvs.length})
							</span>
							<div className="flex gap-1.5">
								<button
									type="button"
									onClick={() => setDetectedEnvs([])}
									className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
								>
									{t("apiExplorer:actions.cancel")}
								</button>
								<Button
									size="sm"
									onClick={importDetected}
									disabled={selectedDetected.size === 0}
								>
									{t("apiExplorer:environments.importSelected")} (
									{selectedDetected.size})
								</Button>
							</div>
						</div>
						<div className="space-y-1.5">
							{detectedEnvs.map((env, idx) => (
								<label
									key={`${env.name}-${env.baseUrl}`}
									className="flex items-center gap-2.5 cursor-pointer group"
								>
									<input
										type="checkbox"
										checked={selectedDetected.has(idx)}
										onChange={() => toggleDetected(idx)}
										className="accent-emerald-400 shrink-0"
									/>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="text-xs font-medium text-[var(--color-text-primary)]">
												{env.name}
											</span>
											<span className="text-[9px] font-mono text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1">
												{env.source}
											</span>
										</div>
										<span className="text-[10px] font-mono text-emerald-400/80 truncate block">
											{env.baseUrl}
										</span>
									</div>
								</label>
							))}
						</div>
					</div>
				)}

				{isAdding ? (
					<div className="mt-3 border border-[var(--color-border)] rounded-lg p-3 space-y-2">
						<input
							className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-sm text-[var(--color-text-primary)]"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							placeholder={t("apiExplorer:environments.namePlaceholder")}
						/>
						<input
							className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-sm font-mono text-[var(--color-text-primary)]"
							value={newUrl}
							onChange={(e) => setNewUrl(e.target.value)}
							placeholder="https://api.example.com"
						/>
						<div>
							<div className="text-[10px] text-[var(--color-text-muted)] mb-0.5">
								{t("apiExplorer:environments.token")}
							</div>
							<div className="flex gap-1">
								<input
									type={newTokenVisible ? "text" : "password"}
									className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)]"
									value={newToken}
									onChange={(e) => setNewToken(e.target.value)}
									placeholder={t("apiExplorer:environments.tokenPlaceholder")}
								/>
								<button
									type="button"
									onClick={() => setNewTokenVisible((v) => !v)}
									className="px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)] transition-colors"
								>
									{newTokenVisible ? "🙈" : "👁"}
								</button>
							</div>
						</div>
						<div>
							<div className="text-[10px] text-[var(--color-text-muted)] mb-0.5">
								{t("apiExplorer:environments.headers")}
							</div>
							<textarea
								className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono text-[var(--color-text-primary)] resize-none"
								rows={2}
								value={newHeaders}
								onChange={(e) => setNewHeaders(e.target.value)}
								placeholder="X-API-Key: key"
							/>
						</div>
						<div className="flex gap-2 justify-end">
							<Button
								size="sm"
								variant="outline"
								onClick={() => setIsAdding(false)}
							>
								{t("apiExplorer:actions.cancel")}
							</Button>
							<Button size="sm" onClick={addNew} disabled={!newName || !newUrl}>
								{t("apiExplorer:actions.add")}
							</Button>
						</div>
					</div>
				) : (
					<div className="mt-3 flex gap-2">
						{activeProject && (
							<button
								type="button"
								onClick={runDetection}
								disabled={isDetecting}
								className="flex-1 border border-dashed border-emerald-400/30 rounded-lg py-2 text-sm text-emerald-400/70 hover:text-emerald-400 hover:border-emerald-400/50 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
							>
								{isDetecting ? (
									<Loader2 size={13} className="animate-spin" />
								) : (
									<ScanSearch size={13} />
								)}
								{isDetecting
									? t("apiExplorer:environments.detecting")
									: t("apiExplorer:environments.detect")}
							</button>
						)}
						<button
							type="button"
							onClick={() => setIsAdding(true)}
							className="flex-1 border border-dashed border-[var(--color-border)] rounded-lg py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border-hover)] transition-colors flex items-center justify-center gap-2"
						>
							<Plus size={14} />
							{t("apiExplorer:environments.addNew")}
						</button>
					</div>
				)}
			</div>
		</div>,
		document.getElementById("root") ?? document.body,
	);
}
