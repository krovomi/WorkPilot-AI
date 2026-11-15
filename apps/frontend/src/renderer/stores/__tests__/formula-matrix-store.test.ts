/**
 * The Formula Lab store: how it ranks Provider × LLM × Effort formulas as the
 * Cost ↔ Confidence slider moves, the four smart picks, the efficiency
 * frontier, what it asks the main process for, and what applying or refining
 * a formula changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistUpdateTask = vi.hoisted(() => vi.fn());
vi.mock("../task-store", () => ({ persistUpdateTask }));

import type { Formula, FormulaMatrix } from "../formula-matrix-store";
import {
	formulaKey,
	paretoFront,
	pickSmart,
	rankFormulas,
	useFormulaMatrixStore,
} from "../formula-matrix-store";

function formula(over: Partial<Formula>): Formula {
	return {
		provider: "anthropic",
		model: "m",
		effort: "medium",
		tier: "mid",
		per_token_billed: true,
		expected_input_tokens: 1000,
		expected_output_tokens: 500,
		expected_thinking_tokens: 0,
		expected_cost_usd: 1,
		low_cost_usd: 0.5,
		high_cost_usd: 2,
		success_probability: 0.5,
		value_score: 0.5,
		energy_kwh: 0,
		rationale: [],
		...over,
	};
}

const CHEAP = formula({
	model: "cheap",
	expected_cost_usd: 0.1,
	success_probability: 0.4,
	value_score: 4,
	expected_input_tokens: 3000,
});
const SAFE = formula({
	model: "safe",
	expected_cost_usd: 3,
	success_probability: 0.95,
	value_score: 0.3,
});
const DOMINATED = formula({
	model: "dominated",
	expected_cost_usd: 4,
	success_probability: 0.6,
	value_score: 0.15,
});
const FAST = formula({
	model: "fast",
	expected_cost_usd: 1,
	success_probability: 0.7,
	value_score: 0.7,
	expected_input_tokens: 100,
	expected_output_tokens: 50,
});

function matrix(formulas: Formula[]): FormulaMatrix {
	return {
		ticket_id: "t1",
		complexity_score: 5,
		footprint: {
			subtask_count: 1,
			touched_files: 1,
			loc_in_scope: 10,
			has_implementation_plan: false,
			complexity_score: 5,
		},
		history_samples: 0,
		formulas,
		warnings: [],
	};
}

const api = { runFormulaMatrix: vi.fn(), refineFormulas: vi.fn() };
const INITIAL = useFormulaMatrixStore.getState();
const store = () => useFormulaMatrixStore.getState();

beforeEach(() => {
	useFormulaMatrixStore.setState(INITIAL, true);
	api.runFormulaMatrix.mockReset();
	api.refineFormulas.mockReset();
	persistUpdateTask.mockReset();
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
});

describe("formula ranking helpers", () => {
	it("keys a formula by provider, model and effort", () => {
		expect(formulaKey(SAFE)).toBe("anthropic::safe::medium");
	});

	it("puts the cheapest first when cost wins, the safest when confidence wins", () => {
		const all = [SAFE, CHEAP, FAST];
		expect(rankFormulas(all, 0)[0]).toBe(CHEAP);
		expect(rankFormulas(all, 1)[0]).toBe(SAFE);
		expect(rankFormulas([], 0.5)).toEqual([]);
	});

	it("ranks on confidence alone when every formula costs the same", () => {
		const a = formula({ model: "a", success_probability: 0.2 });
		const b = formula({ model: "b", success_probability: 0.9 });
		expect(rankFormulas([a, b], 0.1)[0]).toBe(b);
	});

	it("picks the best value, the safest, the cheapest and the fastest", () => {
		expect(pickSmart([CHEAP, SAFE, DOMINATED, FAST])).toEqual({
			bestValue: CHEAP,
			safest: SAFE,
			cheapest: CHEAP,
			fastest: FAST,
		});
		expect(pickSmart([])).toEqual({
			bestValue: null,
			safest: null,
			cheapest: null,
			fastest: null,
		});
	});

	it("breaks ties: the cheaper of two equally safe, the safer of two equally cheap or fast", () => {
		const safeCheap = formula({ model: "sc", success_probability: 0.9, expected_cost_usd: 1 });
		const safeDear = formula({ model: "sd", success_probability: 0.9, expected_cost_usd: 2 });
		const cheapSafe = formula({ model: "cs", success_probability: 0.8, expected_cost_usd: 0.1 });
		const cheapRisky = formula({ model: "cr", success_probability: 0.3, expected_cost_usd: 0.1 });
		expect(pickSmart([safeDear, safeCheap]).safest).toBe(safeCheap);
		expect(pickSmart([cheapRisky, cheapSafe]).cheapest).toBe(cheapSafe);
		expect(pickSmart([cheapRisky, cheapSafe]).fastest).toBe(cheapSafe);
		expect(pickSmart([cheapSafe, cheapRisky]).fastest).toBe(cheapSafe);
	});

	it("keeps on the frontier only the formulas no other beats on both cost and confidence", () => {
		const front = paretoFront([CHEAP, SAFE, DOMINATED, FAST]);
		expect([...front].sort()).toEqual(
			[formulaKey(CHEAP), formulaKey(FAST), formulaKey(SAFE)].sort(),
		);
	});
});

describe("useFormulaMatrixStore opening the lab", () => {
	it("opens on a ticket, preselects the applied formula and fetches the matrix", async () => {
		api.runFormulaMatrix.mockResolvedValue({ matrix: matrix([SAFE]) });
		store().openLab({
			ticketId: "t1",
			ticketTitle: "Add login",
			description: "desc",
			projectPath: "/p",
			specDir: "/p/spec",
			providers: ["anthropic"],
			appliedKey: formulaKey(SAFE),
		});
		expect(store()).toMatchObject({
			isOpen: true,
			ticketId: "t1",
			ticketTitle: "Add login",
			selectedKey: formulaKey(SAFE),
			loading: true,
		});
		await vi.waitFor(() => expect(store().loading).toBe(false));
		expect(api.runFormulaMatrix).toHaveBeenCalledWith({
			ticketId: "t1",
			description: "desc",
			projectPath: "/p",
			specDir: "/p/spec",
			providers: ["anthropic"],
		});
		expect(store().matrix?.formulas).toEqual([SAFE]);
	});

	it("shows why the matrix could not be computed", async () => {
		api.runFormulaMatrix.mockRejectedValueOnce(new Error("no catalog"));
		store().openLab({ ticketId: "t1", ticketTitle: "x" });
		await vi.waitFor(() => expect(store().error).toBe("no catalog"));
		expect(store().selectedKey).toBeNull();

		api.runFormulaMatrix.mockRejectedValueOnce("offline");
		await store().fetchMatrix();
		expect(store()).toMatchObject({ error: "offline", loading: false });
	});

	it("fetches nothing when the lab is not open", async () => {
		await store().fetchMatrix();
		expect(api.runFormulaMatrix).not.toHaveBeenCalled();
	});

	it("forgets the ticket on close but keeps the slider", () => {
		useFormulaMatrixStore.setState({
			isOpen: true,
			ticketId: "t1",
			matrix: matrix([SAFE]),
			selectedKey: "k",
			weight: 0.8,
			refineError: "x",
		});
		store().closeLab();
		expect(store()).toMatchObject({
			isOpen: false,
			ticketId: null,
			matrix: null,
			selectedKey: null,
			refineError: null,
			weight: 0.8,
		});
	});

	it("clamps the slider between 0 and 1 and selects a formula", () => {
		store().setWeight(1.7);
		expect(store().weight).toBe(1);
		store().setWeight(-2);
		expect(store().weight).toBe(0);
		store().setSelectedKey("k");
		expect(store().selectedKey).toBe("k");
	});
});

describe("useFormulaMatrixStore applying a formula", () => {
	it("writes the formula as the engine of every phase of the task", async () => {
		useFormulaMatrixStore.setState({ ticketId: "t1" });
		persistUpdateTask.mockResolvedValue(true);
		const opus = formula({ model: "opus", effort: "high", expected_cost_usd: 2, success_probability: 0.9 });
		expect(await store().applyFormula(opus)).toBe(true);
		const [id, { metadata }] = persistUpdateTask.mock.calls[0];
		expect(id).toBe("t1");
		expect(metadata.engineLocked).toBe(true);
		expect(metadata.phaseModels).toMatchObject({ spec: "opus", coding: "opus", qa: "opus" });
		expect(metadata.appliedFormula).toMatchObject({
			provider: "anthropic",
			model: "opus",
			effort: "high",
			expectedCostUsd: 2,
			successProbability: 0.9,
			perTokenBilled: true,
		});
		expect(store()).toMatchObject({ selectedKey: formulaKey(opus), applying: false });
	});

	it("keeps the selection when the task could not be saved", async () => {
		useFormulaMatrixStore.setState({ ticketId: "t1", selectedKey: "before" });
		persistUpdateTask.mockResolvedValue(false);
		expect(await store().applyFormula(SAFE)).toBe(false);
		expect(store()).toMatchObject({ selectedKey: "before", applying: false });
	});

	it("applies nothing without a ticket", async () => {
		expect(await store().applyFormula(SAFE)).toBe(false);
		expect(persistUpdateTask).not.toHaveBeenCalled();
	});
});

describe("useFormulaMatrixStore AI refine pass", () => {
	it("sends the top formulas for the current slider and merges the sharpened odds", async () => {
		useFormulaMatrixStore.setState({
			matrix: matrix([CHEAP, SAFE, FAST]),
			weight: 1,
			openArgs: { ticketId: "t1", ticketTitle: "x", description: "desc" },
		});
		api.refineFormulas.mockResolvedValue({
			refined: [
				{ key: formulaKey(SAFE), success_probability: 0.8, reason: "big diff" },
				{ key: formulaKey(CHEAP), success_probability: 0.5, reason: "ok" },
			],
		});
		await store().refineTopFormulas(2);
		const { description, candidates } = api.refineFormulas.mock.calls[0][0];
		expect(description).toBe("desc");
		expect(candidates.map((c: { key: string }) => c.key)).toEqual([
			formulaKey(SAFE),
			formulaKey(FAST),
		]);
		expect(candidates[0]).toMatchObject({ tier: "mid", base_probability: 0.95 });
		const [cheap, safe, fast] = store().matrix?.formulas ?? [];
		expect(safe).toMatchObject({
			success_probability: 0.8,
			value_score: 0.2667,
			ai_refined: true,
			refine_reason: "big diff",
		});
		expect(cheap.value_score).toBe(5);
		expect(fast).toBe(FAST);
		expect(store().refining).toBe(false);
	});

	it("scores a free formula on its odds alone", async () => {
		const free = formula({ model: "local", expected_cost_usd: 0 });
		useFormulaMatrixStore.setState({ matrix: matrix([free]) });
		api.refineFormulas.mockResolvedValue({
			refined: [{ key: formulaKey(free), success_probability: 0.6, reason: "" }],
		});
		await store().refineTopFormulas();
		expect(store().matrix?.formulas[0].value_score).toBe(4.8);
	});

	it("says when the AI gave no assessment, or why it failed", async () => {
		useFormulaMatrixStore.setState({ matrix: matrix([SAFE]) });
		api.refineFormulas.mockResolvedValueOnce({ refined: [] });
		await store().refineTopFormulas();
		expect(store()).toMatchObject({ refineError: "no_assessment", refining: false });

		api.refineFormulas.mockRejectedValueOnce(new Error("quota"));
		await store().refineTopFormulas();
		expect(store().refineError).toBe("quota");

		api.refineFormulas.mockRejectedValueOnce("down");
		await store().refineTopFormulas();
		expect(store()).toMatchObject({ refineError: "down", refining: false });
	});

	it("refines nothing without formulas", async () => {
		await store().refineTopFormulas();
		useFormulaMatrixStore.setState({ matrix: matrix([]) });
		await store().refineTopFormulas();
		expect(api.refineFormulas).not.toHaveBeenCalled();
	});
});
