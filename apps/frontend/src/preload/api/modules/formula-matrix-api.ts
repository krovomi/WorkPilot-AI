/**
 * Formula Matrix API — renderer-side bridge for the kanban "Formula Lab".
 *
 * Mirrors apps/backend/cost_intelligence/formula_matrix.py. Computes, for one
 * ticket, every Provider × LLM × Effort combination with token/cost estimates
 * and a calibrated success probability — before any tokens are spent.
 */

import { invokeIpc } from "./ipc-utils";

/** One Provider × LLM × Effort candidate. */
export interface Formula {
	provider: string;
	model: string;
	effort: string;
	tier: "flagship" | "mid" | "small" | "local" | string;
	per_token_billed: boolean;
	expected_input_tokens: number;
	expected_output_tokens: number;
	expected_thinking_tokens: number;
	expected_cost_usd: number;
	low_cost_usd: number;
	high_cost_usd: number;
	/** Calibrated probability of feature success, 0-1. */
	success_probability: number;
	/** Default "value" score (success per dollar). */
	value_score: number;
	energy_kwh: number;
	rationale: string[];
}

export interface FormulaFootprint {
	subtask_count: number;
	touched_files: number;
	loc_in_scope: number;
	has_implementation_plan: boolean;
	complexity_score: number;
}

export interface FormulaMatrix {
	ticket_id: string;
	complexity_score: number;
	footprint: FormulaFootprint;
	history_samples: number;
	formulas: Formula[];
	warnings: string[];
}

export interface FormulaMatrixRunOptions {
	ticketId: string;
	description?: string;
	projectPath?: string;
	specDir?: string;
	/** Restrict to these providers (lower-case). Omit for the full catalog. */
	providers?: string[];
	/** Override the derived 1-13 complexity. */
	complexity?: number;
}

export interface FormulaMatrixAPI {
	runFormulaMatrix: (
		options: FormulaMatrixRunOptions,
	) => Promise<{ matrix: FormulaMatrix }>;
}

export const createFormulaMatrixAPI = (): FormulaMatrixAPI => ({
	runFormulaMatrix: (options) =>
		invokeIpc<{ matrix: FormulaMatrix }>("formulaMatrix:run", options),
});
