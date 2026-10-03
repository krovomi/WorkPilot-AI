/**
 * Ce que la carte et l'onglet de vérification lisent d'un enregistrement.
 *
 * Sans React, pour être testé seul : quelle variante de badge pour un verdict,
 * comment résumer les tours de correction, quelle valeur afficher pour une
 * mesure absente. Une mesure absente n'est jamais un zéro — « non mesuré » se
 * lit autrement que « 0 », jusqu'à l'écran.
 */

import type { VerifyRecord, VerifyStatus } from "../../lib/agent-tools-api";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const STATUS_VARIANT: Record<VerifyStatus, BadgeVariant> = {
	pass: "default",
	fail: "destructive",
	unknown: "outline",
	"not-applicable": "secondary",
	disabled: "secondary",
	running: "outline",
};

export function statusVariant(status: string | undefined): BadgeVariant {
	return STATUS_VARIANT[(status ?? "unknown") as VerifyStatus] ?? "outline";
}

/** Erreurs restantes, toutes cibles et plateformes confondues. */
export function remainingErrors(record: VerifyRecord): number {
	return (
		record.targets.reduce((n, t) => n + (t.errors?.length ?? 0), 0) +
		record.mobile.reduce((n, m) => n + (m.errors?.length ?? 0), 0)
	);
}

/** `{ rounds, fixed }` — combien de tours de correction, combien ont fait baisser le compte. */
export function roundsSummary(record: VerifyRecord): { rounds: number; fixed: number } {
	return {
		rounds: record.rounds.length,
		fixed: record.rounds.filter((r) => r.fixed).length,
	};
}

/** Endpoints appelés : conformes / appelés (l'authentification requise n'est ni l'un ni l'autre). */
export function endpointSummary(record: VerifyRecord): { ok: number; called: number; auth: number } {
	const called = record.endpoints.filter((e) => (e.outcome ?? "called") === "called");
	return {
		ok: called.filter((e) => e.ok).length,
		called: called.length,
		auth: record.endpoints.filter((e) => e.outcome === "auth").length,
	};
}

/** Une mesure, ou `null` quand elle n'a pas été prise — jamais `0` par défaut. */
export function measured(value: number | null | undefined, digits = 0): string | null {
	if (value === null || value === undefined || Number.isNaN(value)) return null;
	return digits > 0 ? value.toFixed(digits) : String(Math.round(value));
}
