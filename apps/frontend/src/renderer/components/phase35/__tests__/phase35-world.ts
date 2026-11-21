/**
 * What every Phase 3-5 panel test starts from: the real stores back to their
 * first state, the app in English, and `electronAPI` as the only double.
 *
 * A channel a test does not answer is refused like an unreachable backend
 * would refuse it, so a panel that calls something unexpected shows it.
 */
import { vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { useI18nEditorStore } from "../../../stores/i18n-editor-store";
import {
	useAgentHealthStore,
	useArchDriftStore,
	useAuditTrailStore,
	useCicdAnomalyStore,
	useCogContextStore,
	useDomainAgentsStore,
	useGenTestsStore,
	useI18nScalerStore,
	useLicenseStore,
	useLongevityStore,
	useModelRouterStore,
	usePairRealtimeStore,
} from "../../../stores/phase35-stores";

const STORES = [
	useAgentHealthStore,
	useArchDriftStore,
	useAuditTrailStore,
	useCicdAnomalyStore,
	useCogContextStore,
	useDomainAgentsStore,
	useGenTestsStore,
	useI18nScalerStore,
	useLicenseStore,
	useLongevityStore,
	useModelRouterStore,
	usePairRealtimeStore,
	useI18nEditorStore,
] as const;
const INITIAL = STORES.map((s) => s.getState());

export type Api = Record<string, ReturnType<typeof vi.fn>>;

/** Real stores, English, and an `electronAPI` that answers only what `answers` gives. */
export async function openWorld(answers: Record<string, (...args: never[]) => unknown> = {}): Promise<Api> {
	await i18n.changeLanguage("en");
	STORES.forEach((s, i) => (s as unknown as { setState: (v: unknown, r: true) => void }).setState(INITIAL[i], true));
	const api: Api = {};
	for (const [name, impl] of Object.entries(answers)) api[name] = vi.fn(impl);
	const proxy = new Proxy(api, {
		get(target, name: string | symbol) {
			// Not a thenable: `await openWorld()` must not mistake the API for a promise.
			if (typeof name !== "string" || name === "then") return undefined;
			target[name] ??= vi.fn(async () => ({ success: false, error: `${name} is not answered` }));
			return target[name];
		},
	});
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = proxy;
	// The EUR rate is fetched in French; no test reaches the network.
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ rates: { EUR: 0.5 } }))) as never;
	return proxy;
}

/** A promise the test resolves when it chooses, to hold a call in flight. */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
