/**
 * The Arena's roster: every model of every provider configured on this machine.
 *
 * Two answers the app already has, joined — provider configuration
 * (`getStaticProviders`, what the "Fournisseur IA" list is built from) and the
 * per-provider model catalog (`fetchProviderModelCatalog`, live from the
 * provider with the generated registry as fallback). Nothing here knows the
 * name of a single provider or model, so both lists growing reaches the Arena
 * on its own.
 */

import type { ArenaContender } from "@shared/types/arena";
import {
	buildArenaContenders,
	type ProviderCatalogInput,
} from "@shared/utils/arena-contenders";
import { getStaticProviders } from "@shared/utils/providers";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { fetchProviderModelCatalog } from "./useProviderModelCatalog";

interface AgenticCapability {
	hasAdapter: boolean;
	degradesTo: string | null;
}

/**
 * Which providers drive their own models. An unreadable matrix lets everyone
 * in: refusing every provider because one fetch failed would empty the page
 * over a backend that is merely still starting, and the per-participant
 * refusal in the backend is the guarantee that nothing is ever mislabelled.
 */
async function fetchAgenticCapabilities(): Promise<
	Record<string, AgenticCapability>
> {
	try {
		const baseUrl = import.meta.env?.VITE_BACKEND_URL || "";
		const res = await fetch(`${baseUrl}/providers/agentic-capabilities`);
		if (!res.ok) return {};
		const data = (await res.json()) as {
			providers?: Record<string, AgenticCapability>;
		};
		return data?.providers ?? {};
	} catch {
		return {};
	}
}

export interface ArenaRoster {
	contenders: ArenaContender[];
	/** Configured providers that produced at least one contender. */
	providers: Array<{ name: string; label: string; count: number }>;
	/** Configured providers whose catalog could not be read, with the reason. */
	unreachable: Array<{ name: string; label: string; error: string }>;
	/**
	 * Configured providers left out because they have no adapter of their own,
	 * with the provider that would have answered for them.
	 */
	degrading: Array<{ name: string; label: string; degradesTo: string }>;
	loading: boolean;
	/** True once a load has finished, whatever it found. */
	loaded: boolean;
	refresh: () => void;
}

export function useArenaContenders(): ArenaRoster {
	const { profiles, settings } = useSettingsStore();
	const [roster, setRoster] = useState<
		Omit<ArenaRoster, "refresh" | "loading">
	>({
		contenders: [],
		providers: [],
		unreachable: [],
		degrading: [],
		loaded: false,
	});
	const [loading, setLoading] = useState(true);
	const [refreshCount, setRefreshCount] = useState(0);
	const lastForcedRef = useRef(0);

	const refresh = useCallback(() => {
		setRefreshCount((count) => count + 1);
	}, []);

	useEffect(() => {
		let cancelled = false;
		// A bump of `refreshCount` is the user asking for fresh data, so the
		// provider catalogs are re-fetched. A re-render caused by a settings
		// change is not, and must not bypass their TTL — otherwise every
		// keystroke in Settings would call every provider.
		const force = refreshCount > lastForcedRef.current;
		lastForcedRef.current = refreshCount;
		setLoading(true);

		(async () => {
			const [{ providers, status }, capabilities] = await Promise.all([
				getStaticProviders(
					profiles,
					settings as unknown as Record<string, unknown>,
				),
				fetchAgenticCapabilities(),
			]);
			if (cancelled) return;

			const allConfigured = providers.filter((p) => status[p.name]);
			const degrading = allConfigured
				.filter((p) => capabilities[p.name]?.hasAdapter === false)
				.map((p) => ({
					name: p.name,
					label: p.label,
					degradesTo: capabilities[p.name]?.degradesTo || "claude",
				}));
			const degradingNames = new Set(degrading.map((p) => p.name));
			const configured = allConfigured.filter(
				(p) => !degradingNames.has(p.name),
			);

			const catalogs: Record<string, ProviderCatalogInput | undefined> = {};
			const results = await Promise.all(
				configured.map(async (provider) => {
					const catalog = await fetchProviderModelCatalog(provider.name, force);
					return { provider, catalog };
				}),
			);
			if (cancelled) return;

			for (const { provider, catalog } of results) {
				catalogs[provider.name] = {
					models: catalog.models,
					source: catalog.source,
				};
			}

			const contenders = buildArenaContenders({
				providers: configured,
				status,
				catalogs,
			});

			const counted = configured.map((provider) => ({
				name: provider.name,
				label: provider.label,
				count: contenders.filter((c) => c.provider === provider.name).length,
			}));

			// A provider is reported as unreachable when it is configured and
			// still produced nobody — a failed catalog call, or a local server
			// that is not running so none of its models is pulled. A provider
			// with contenders is never reported, even if its catalog errored:
			// the fallback answered, and a warning about a list that works is a
			// warning people learn to ignore.
			setRoster({
				contenders,
				degrading,
				providers: counted.filter((p) => p.count > 0),
				unreachable: counted
					.filter((p) => p.count === 0)
					.map((p) => ({
						name: p.name,
						label: p.label,
						error:
							results.find((r) => r.provider.name === p.name)?.catalog.error ??
							"no-models",
					})),
				loaded: true,
			});
			setLoading(false);
		})().catch(() => {
			if (cancelled) return;
			setRoster((prev) => ({ ...prev, loaded: true }));
			setLoading(false);
		});

		return () => {
			cancelled = true;
		};
	}, [profiles, settings, refreshCount]);

	return { ...roster, loading, refresh };
}
