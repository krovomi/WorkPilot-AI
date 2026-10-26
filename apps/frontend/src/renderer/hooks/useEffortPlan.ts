/**
 * Ce que le modèle reçoit pour chaque niveau d'effort.
 *
 * Le sélecteur propose cinq niveaux sur tous les fournisseurs, et chaque
 * fournisseur a son échelle — ou n'en a pas : Windsurf, OpenCode, gpt-4o,
 * grok-4.3 ne reçoivent rien, Claude reçoit « low » pour « aucun ». Le
 * backend sert la réponse que ses clients appliquent eux-mêmes
 * (`core/effort_plan.py`, `GET /providers/effort`) : servie et non recopiée
 * en TypeScript, pour la raison écrite dans `useAgenticCapabilities`.
 */

import { useEffect, useState } from "react";
import type { ThinkingLevel } from "../../shared/types/settings";

/**
 * `native` : la valeur est envoyée ; `none` : aucun réglage n'atteint ce
 * modèle, le niveau est sans effet ; `runtime` : décidé au lancement, selon ce
 * que le serveur dit du modèle (Copilot, Ollama).
 */
export type EffortControl = "native" | "none" | "runtime";

export interface EffortPlan {
	control: EffortControl;
	/** Le mot du fournisseur pour chaque niveau, `null` quand rien n'est envoyé. */
	levels: Partial<Record<ThinkingLevel, string | null>>;
}

const cache = new Map<string, Promise<EffortPlan | null>>();

function isPlan(value: unknown): value is EffortPlan {
	if (!value || typeof value !== "object") return false;
	const plan = value as { control?: unknown; levels?: unknown };
	return (
		(plan.control === "native" ||
			plan.control === "none" ||
			plan.control === "runtime") &&
		Boolean(plan.levels) &&
		typeof plan.levels === "object"
	);
}

/**
 * Un plan illisible ne dit rien plutôt que de deviner : le sélecteur reste tel
 * qu'avant, et le backend trace de toute façon ce qu'il envoie.
 */
export function fetchEffortPlan(
	provider: string,
	model: string,
): Promise<EffortPlan | null> {
	const key = `${provider}\u0000${model}`;
	const known = cache.get(key);
	if (known) return known;
	const request = (async () => {
		try {
			const baseUrl = import.meta.env?.VITE_BACKEND_URL || "";
			const query = new URLSearchParams({ provider, model });
			const res = await fetch(`${baseUrl}/providers/effort?${query}`);
			if (!res.ok) return null;
			const data: unknown = await res.json();
			return isPlan(data) ? data : null;
		} catch {
			return null;
		}
	})();
	cache.set(key, request);
	// A failure is not remembered: the backend may simply not be up yet.
	void request.then((plan) => {
		if (plan === null) cache.delete(key);
	});
	return request;
}

/** Vide le cache (tests). */
export function resetEffortPlanCache(): void {
	cache.clear();
}

export function useEffortPlan(
	provider: string,
	model: string,
): EffortPlan | null {
	const [plan, setPlan] = useState<EffortPlan | null>(null);
	useEffect(() => {
		let cancelled = false;
		setPlan(null);
		if (!provider) return;
		void fetchEffortPlan(provider, model).then((result) => {
			if (!cancelled) setPlan(result);
		});
		return () => {
			cancelled = true;
		};
	}, [provider, model]);
	return plan;
}

/** What the picker should say under the effort, or null to say nothing. */
export type EffortNote =
	| { kind: "notApplied" }
	| { kind: "sentAs"; value: string }
	| { kind: "runtime" };

export function effortNote(
	plan: EffortPlan | null,
	effort: ThinkingLevel,
): EffortNote | null {
	if (!plan) return null;
	if (plan.control === "none") {
		return effort === "none" ? null : { kind: "notApplied" };
	}
	if (plan.control === "runtime") return { kind: "runtime" };
	const sent = plan.levels[effort];
	if (sent && sent !== effort) return { kind: "sentAs", value: sent };
	return null;
}
