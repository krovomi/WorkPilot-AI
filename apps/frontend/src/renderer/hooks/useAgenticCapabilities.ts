/**
 * Quels fournisseurs pilotent leurs propres modèles.
 *
 * La matrice vit dans `capabilities/providers.yaml` et le backend la sert
 * telle quelle (`GET /providers/agentic-capabilities`) : un fournisseur dont
 * `adapter` est nul est exécuté par le SDK Claude, ce qui est le bon compromis
 * pour un build — la tâche tourne — et le mauvais partout où le nom du
 * fournisseur est *le* résultat : une arène, un concours.
 *
 * Servie et non recopiée en TypeScript, pour la raison déjà écrite dans
 * `useArenaContenders` : une seconde copie dériverait le jour où un adaptateur
 * est écrit. Ce module existe parce qu'une troisième lecture du même endpoint
 * serait une troisième copie de la même prudence.
 */

import { useEffect, useState } from "react";

export interface AgenticCapability {
	hasAdapter: boolean;
	degradesTo: string | null;
}

export type AgenticCapabilities = Record<string, AgenticCapability>;

/**
 * Une matrice illisible laisse tout le monde entrer : vider une page parce que
 * le backend démarre encore serait pire que le défaut qu'elle protège, et le
 * refus côté backend (par participant) est ce qui tient la promesse.
 */
export async function fetchAgenticCapabilities(): Promise<AgenticCapabilities> {
	try {
		const baseUrl = import.meta.env?.VITE_BACKEND_URL || "";
		const res = await fetch(`${baseUrl}/providers/agentic-capabilities`);
		if (!res.ok) return {};
		const data = (await res.json()) as {
			providers?: AgenticCapabilities;
		};
		return data?.providers ?? {};
	} catch {
		return {};
	}
}

/**
 * `anthropic` et `claude` sont un seul fournisseur ; la matrice l'épelle
 * `claude`, l'UI `anthropic`. Répondre « pas d'adaptateur » pour le
 * fournisseur le mieux pris en charge de l'application serait la seule erreur
 * coûteuse ici.
 */
function canonical(provider: string): string {
	const value = (provider || "").trim().toLowerCase();
	if (value === "anthropic") return "claude";
	if (value === "lm-studio") return "lmstudio";
	if (value === "llama-cpp") return "local";
	return value;
}

export interface AgenticCapabilitiesState {
	capabilities: AgenticCapabilities;
	/** Faux uniquement quand la matrice dit explicitement « pas d'adaptateur ». */
	hasAdapter: (provider: string) => boolean;
	/** Ce qui répondrait à sa place, ou `null` quand la question ne se pose pas. */
	degradesTo: (provider: string) => string | null;
	loaded: boolean;
}

export function useAgenticCapabilities(): AgenticCapabilitiesState {
	const [capabilities, setCapabilities] = useState<AgenticCapabilities>({});
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void fetchAgenticCapabilities().then((result) => {
			if (cancelled) return;
			setCapabilities(result);
			setLoaded(true);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return {
		capabilities,
		hasAdapter: (provider) =>
			capabilities[canonical(provider)]?.hasAdapter !== false,
		degradesTo: (provider) => {
			const entry = capabilities[canonical(provider)];
			if (!entry || entry.hasAdapter) return null;
			return entry.degradesTo || "claude";
		},
		loaded,
	};
}
