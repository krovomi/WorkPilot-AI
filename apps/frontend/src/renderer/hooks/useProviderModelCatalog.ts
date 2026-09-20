/** Shared provider catalog. Every selector subscribes to the same snapshot.
 * Live discovery is refreshed while in use and on window focus. Static entries
 * are generated from the backend registry and are only an offline fallback.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
	dedupeModelCatalog,
	getModelsForProvider,
	sortClaudeCatalog,
} from "../../shared/constants/models";
import { dedupeLocalCatalog } from "../../shared/utils/local-models";

export type CatalogSource = "live" | "cache" | "static";

/** Subset of ProviderModel — `tier` and `supportsThinking` are optional. */
export interface CatalogModel {
	value: string;
	label: string;
	tier?: "flagship" | "standard" | "fast" | "local";
	supportsThinking?: boolean;
	/**
	 * For local providers (Ollama/LM Studio) only: whether this model is
	 * actually pulled on the server (came from the live /api/tags listing) vs
	 * merely a catalog suggestion the user could download.
	 */
	installed?: boolean;
	/**
	 * For local providers only: whether the model supports native tool-calling.
	 * `false` means the backend confirmed it CANNOT drive agentic phases, so the
	 * picker hides it. `undefined` = unknown (kept).
	 */
	supports_tools?: boolean;
	/** For local providers only: parameter count in billions (e.g. 8, 70). Used
	 * to warn that a small model is weak for planning. null/undefined = unknown. */
	param_b?: number | null;
}

export interface ProviderModelCatalog {
	models: readonly CatalogModel[];
	source: CatalogSource;
	fetchedAt: number | null;
	error: string | null;
	loading: boolean;
	refresh: () => void;
}

interface CatalogResponse {
	provider: string;
	models: CatalogModel[];
	source: CatalogSource;
	fetchedAt: number | null;
	error: string | null;
}

interface CatalogState {
	snapshot: Omit<ProviderModelCatalog, "refresh">;
	listeners: Set<() => void>;
	pending?: Promise<void>;
	refreshAfterPending?: boolean;
	checkedAt: number;
	timer?: ReturnType<typeof setInterval>;
}
const catalogs = new Map<string, CatalogState>();
const isLocal = (provider: string) =>
	["ollama", "local", "lm-studio", "llama-cpp"].includes(provider);
const normalize = (provider: string) =>
	({
		local: "ollama",
		claude: "anthropic",
		gemini: "google",
		lmstudio: "lm-studio",
		llamacpp: "llama-cpp",
	})[provider] ?? provider;
const ttl = (provider: string) => (isLocal(provider) ? 30_000 : 15 * 60_000);

function prepareModels(
	provider: string,
	live: readonly CatalogModel[],
	source: CatalogSource,
): CatalogModel[] {
	const fallback = getModelsForProvider(provider);
	const merged = dedupeModelCatalog<CatalogModel>([...live, ...fallback]);
	if (provider === "anthropic") return sortClaudeCatalog(merged);
	if (isLocal(provider)) {
		return dedupeLocalCatalog(
			merged,
			source === "static" ? [] : live.map((m) => m.value),
		).filter((m) => m.supports_tools !== false);
	}
	return merged;
}

function stateFor(provider: string): CatalogState {
	let state = catalogs.get(provider);
	if (!state) {
		state = {
			snapshot: {
				models: prepareModels(provider, [], "static"),
				source: "static",
				fetchedAt: null,
				error: null,
				loading: false,
			},
			listeners: new Set(),
			checkedAt: 0,
		};
		catalogs.set(provider, state);
	}
	return state;
}
function publish(
	state: CatalogState,
	patch: Partial<CatalogState["snapshot"]>,
) {
	state.snapshot = { ...state.snapshot, ...patch };
	for (const listener of state.listeners) listener();
}
async function load(provider: string, force = false): Promise<void> {
	const state = stateFor(provider);
	if (!provider) return;
	if (state.pending) {
		if (force) state.refreshAfterPending = true;
		return state.pending;
	}
	if (!force && Date.now() - state.checkedAt < ttl(provider)) return;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	publish(state, { loading: true });
	state.pending = (async () => {
		try {
			const baseUrl = import.meta.env?.VITE_BACKEND_URL || "";
			const res = await fetch(
				`${baseUrl}/providers/models/${encodeURIComponent(provider)}/catalog${force ? "?refresh=true" : ""}`,
				{ signal: controller.signal },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			if (!res.headers.get("content-type")?.includes("application/json"))
				throw new Error("non-json");
			const data = (await res.json()) as CatalogResponse;
			if (controller.signal.aborted) return;
			if (
				!Array.isArray(data.models) ||
				data.models.some(
					(m) =>
						!m ||
						typeof m.value !== "string" ||
						!m.value ||
						typeof m.label !== "string",
				)
			)
				throw new Error("invalid-catalog");
			publish(state, {
				models: prepareModels(provider, data.models, data.source),
				source: data.source,
				fetchedAt: data.fetchedAt ?? null,
				error: data.error ?? null,
			});
		} catch (err) {
			publish(state, {
				error: err instanceof Error ? err.message : "fetch_failed",
				...(isLocal(provider)
					? {
							models: prepareModels(provider, [], "static"),
							source: "static" as const,
							fetchedAt: null,
						}
					: {}),
			});
		} finally {
			clearTimeout(timeout);
			state.checkedAt = Date.now();
			state.pending = undefined;
			publish(state, { loading: false });
			if (state.refreshAfterPending) {
				state.refreshAfterPending = false;
				queueMicrotask(() => {
					void load(provider, true);
				});
			}
		}
	})();
	return state.pending;
}
function subscribe(provider: string, listener: () => void) {
	const state = stateFor(provider);
	state.listeners.add(listener);
	const onFocus = () => {
		void load(provider);
	};
	window.addEventListener("focus", onFocus);
	if (state.listeners.size === 1) {
		state.timer = setInterval(onFocus, ttl(provider));
	}
	void load(provider);
	return () => {
		state.listeners.delete(listener);
		// Remove the exact callback registered by this subscription, even if another
		// screen is still subscribed. Each active screen also revalidates on focus.
		window.removeEventListener("focus", onFocus);
		if (!state.listeners.size) {
			clearInterval(state.timer);
		}
	};
}
export function useProviderModelCatalog(
	provider: string,
): ProviderModelCatalog {
	const key = normalize(provider.trim().toLowerCase());
	const snapshot = useSyncExternalStore(
		useCallback((listener) => subscribe(key, listener), [key]),
		useCallback(() => stateFor(key).snapshot, [key]),
	);
	const refresh = useCallback(() => {
		void load(key, true);
	}, [key]);
	return { ...snapshot, refresh };
}

/**
 * The same catalog, awaited once, for callers that are not a component.
 *
 * The Arena needs every configured provider's catalog at once, which a hook
 * cannot express (one hook per provider, and the set is only known at runtime).
 * It goes through the same cache, the same TTL and the same in-flight
 * deduplication as the hook — a second fetcher would be a second answer to
 * "what models does this provider have".
 */
export async function fetchProviderModelCatalog(
	provider: string,
	force = false,
): Promise<Omit<ProviderModelCatalog, "refresh">> {
	const key = normalize(provider.trim().toLowerCase());
	await load(key, force);
	return stateFor(key).snapshot;
}

/** Invalidate after a provider configuration or local inventory changes. */
export function refreshProviderModelCatalog(provider: string): void {
	const key = normalize(provider.trim().toLowerCase());
	const state = stateFor(key);
	state.checkedAt = 0;
	if (state.listeners.size) void load(key, true);
}
