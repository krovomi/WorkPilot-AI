/**
 * The Formula Lab dialog, as the person uses it: it opens on a ticket, asks the
 * main process for every Provider × LLM × Effort formula, shows four smart
 * picks, the efficiency frontier and a sortable, filterable table, and applies
 * the chosen formula to the task. Only `electronAPI` is mocked; the stores and
 * i18n are the real ones.
 */
import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	type Formula,
	type FormulaMatrix,
	formulaKey,
	useFormulaMatrixStore,
} from "../../../stores/formula-matrix-store";
import { useToast } from "../../../hooks/use-toast";
import { Toaster } from "../../ui/toaster";
import { FormulaLab } from "../FormulaLab";

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

/** Safest pick. */
const OPUS = formula({
	model: "claude-opus-5-20260101",
	effort: "high",
	tier: "flagship",
	expected_input_tokens: 10_000,
	expected_output_tokens: 5000,
	expected_thinking_tokens: 2000,
	expected_cost_usd: 2,
	low_cost_usd: 1.5,
	high_cost_usd: 3,
	success_probability: 0.9,
	value_score: 0.45,
});
/** Best value. */
const GPT = formula({
	provider: "openai",
	model: "gpt-5.5",
	effort: "low",
	expected_input_tokens: 3000,
	expected_output_tokens: 1000,
	expected_cost_usd: 0.5,
	low_cost_usd: 0.25,
	high_cost_usd: 1,
	success_probability: 0.7,
	value_score: 1.4,
});
/** Cheapest: free, downloaded local model. */
const LLAMA = formula({
	provider: "ollama",
	model: "llama3",
	effort: "none",
	tier: "local",
	per_token_billed: false,
	installed: true,
	expected_input_tokens: 2_000_000,
	expected_output_tokens: 0,
	expected_cost_usd: 0,
	low_cost_usd: 0,
	high_cost_usd: 0,
	success_probability: 0.45,
	value_score: 1,
});
/** Fastest: fewest tokens, not downloaded. */
const QWEN = formula({
	provider: "ollama",
	model: "qwen",
	effort: "medium",
	tier: "local",
	per_token_billed: false,
	installed: false,
	expected_input_tokens: 1000,
	expected_output_tokens: 500,
	expected_cost_usd: 0,
	low_cost_usd: 0,
	high_cost_usd: 0,
	success_probability: 0.3,
	value_score: 0.9,
});
/** Dominated, measured cost, already refined by the AI pass. */
const GEMINI = formula({
	provider: "google",
	model: "gemini",
	effort: "ultrathink",
	expected_input_tokens: 40_000,
	expected_output_tokens: 10_000,
	expected_cost_usd: 5,
	low_cost_usd: 4,
	high_cost_usd: 6,
	success_probability: 0.6,
	value_score: 0.12,
	cost_basis: "measured",
	ai_refined: true,
	refine_reason: "Large refactor across modules",
});

const ALL = [OPUS, GPT, LLAMA, QWEN, GEMINI];

function matrixOf(formulas: Formula[], over: Partial<FormulaMatrix> = {}): FormulaMatrix {
	return {
		ticket_id: "task-1",
		complexity_score: 5,
		footprint: {
			subtask_count: 3,
			touched_files: 4,
			loc_in_scope: 200,
			has_implementation_plan: true,
			complexity_score: 5,
		},
		history_samples: 0,
		formulas,
		warnings: [],
		...over,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let api: {
	runFormulaMatrix: ReturnType<typeof vi.fn>;
	refineFormulas: ReturnType<typeof vi.fn>;
	updateTask: ReturnType<typeof vi.fn>;
};
const originalApi = (globalThis as { electronAPI?: unknown }).electronAPI;

const INITIAL = useFormulaMatrixStore.getState();

beforeEach(async () => {
	await i18n.changeLanguage("en");
	api = {
		runFormulaMatrix: vi.fn(async () => ({ matrix: matrixOf(ALL) })),
		refineFormulas: vi.fn(async () => ({ refined: [] })),
		updateTask: vi.fn(async (_id: string, updates: unknown) => ({
			success: true,
			data: { title: "Add login", description: "", ...(updates as object) },
		})),
	};
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useFormulaMatrixStore.setState(INITIAL, true);
});

afterEach(() => {
	// Toasts live in module state: close this test's toast before the next one.
	const { result } = renderHook(() => useToast());
	act(() => result.current.dismiss());
	(globalThis as { electronAPI?: unknown }).electronAPI = originalApi;
	vi.restoreAllMocks();
});

/**
 * The toast's own title and description, not the live region that repeats
 * them for about a second after the toast opens.
 */
const TOAST = { selector: "div" };

function renderLab() {
	return render(
		<>
			<FormulaLab />
			<Toaster />
		</>,
	);
}

function openLab(over: Partial<Parameters<typeof INITIAL.openLab>[0]> = {}) {
	act(() => {
		useFormulaMatrixStore.getState().openLab({
			ticketId: "task-1",
			ticketTitle: "Add login",
			description: "Let people sign in",
			projectPath: "/projects/demo",
			specDir: "001-login",
			...over,
		});
	});
}

async function openWithMatrix(over: Partial<Parameters<typeof INITIAL.openLab>[0]> = {}) {
	renderLab();
	openLab(over);
	await screen.findByRole("table");
}

/** Model names of the table rows, top to bottom. */
function rowModels(): string[] {
	return screen
		.queryAllByRole("button", { name: /^Select / })
		.map((b) => b.textContent ?? "");
}

function pickCard(label: RegExp): HTMLElement {
	return screen.getByRole("button", { name: label });
}

describe("FormulaLab", () => {
	it("renders nothing while the lab is closed", () => {
		renderLab();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks for the ticket's formulas and shows a spinner until they arrive", async () => {
		const answer = deferred<{ matrix: FormulaMatrix }>();
		api.runFormulaMatrix.mockReturnValueOnce(answer.promise);
		renderLab();
		openLab({ providers: ["openai"] });

		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Formula Lab")).toBeInTheDocument();
		expect(within(dialog).getByText("· Add login")).toBeInTheDocument();
		expect(screen.getByText("Computing formulas…")).toBeInTheDocument();
		expect(api.runFormulaMatrix).toHaveBeenCalledWith({
			ticketId: "task-1",
			description: "Let people sign in",
			projectPath: "/projects/demo",
			specDir: "001-login",
			providers: ["openai"],
		});

		await act(async () => answer.resolve({ matrix: matrixOf(ALL) }));
		expect(screen.queryByText("Computing formulas…")).toBeNull();
		expect(screen.getByText("5 formulas")).toBeInTheDocument();
	});

	it("shows a failed estimate and retries it", async () => {
		api.runFormulaMatrix.mockRejectedValueOnce(new Error("backend down"));
		renderLab();
		openLab();

		expect(
			await screen.findByText("Estimation unavailable: backend down"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByRole("table");
		expect(api.runFormulaMatrix).toHaveBeenCalledTimes(2);
		expect(screen.queryByText(/Estimation unavailable/)).toBeNull();
	});

	it("shows a failure that is not an Error as text", async () => {
		api.runFormulaMatrix.mockRejectedValueOnce("timeout");
		renderLab();
		openLab();
		expect(await screen.findByText("Estimation unavailable: timeout")).toBeInTheDocument();
	});

	it("ignores the answer for a ticket the lab is no longer open on", async () => {
		const first = deferred<{ matrix: FormulaMatrix }>();
		const second = deferred<{ matrix: FormulaMatrix }>();
		api.runFormulaMatrix
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		renderLab();
		openLab({ ticketId: "task-1", ticketTitle: "Add login" });
		openLab({ ticketId: "task-2", ticketTitle: "Fix logout" });

		await act(async () => second.resolve({ matrix: matrixOf([GPT]) }));
		await act(async () => first.resolve({ matrix: matrixOf(ALL) }));

		expect(screen.getByText("· Fix logout")).toBeInTheDocument();
		expect(screen.getByText("1 formulas")).toBeInTheDocument();
		expect(rowModels()).toEqual(["gpt-5.5"]);
	});

	it("ignores a late failure for a ticket the lab is no longer open on", async () => {
		const first = deferred<{ matrix: FormulaMatrix }>();
		api.runFormulaMatrix
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ matrix: matrixOf([GPT]) });
		renderLab();
		openLab({ ticketId: "task-1" });
		openLab({ ticketId: "task-2", ticketTitle: "Fix logout" });
		await screen.findByRole("table");

		await act(async () => first.reject(new Error("stale")));
		expect(screen.queryByText(/Estimation unavailable/)).toBeNull();
		expect(rowModels()).toEqual(["gpt-5.5"]);
	});

	it("says the costs are heuristic without run history", async () => {
		await openWithMatrix();
		expect(screen.getByText(/No run history yet/)).toBeInTheDocument();
		expect(screen.queryByText(/judged by the repo bench/)).toBeNull();
	});

	it("says the costs are calibrated and counts the bench replays", async () => {
		api.runFormulaMatrix.mockResolvedValueOnce({
			matrix: matrixOf(ALL, { history_tasks: 4, bench_samples: 2 }),
		});
		await openWithMatrix();
		expect(screen.getByText(/calibrated on 4 real run\(s\)/)).toBeInTheDocument();
		expect(screen.getByText(/also count 2 replay\(s\)/)).toBeInTheDocument();
	});

	it("shows the four smart picks with their formula", async () => {
		await openWithMatrix();
		const best = pickCard(/Best value/);
		expect(best).toHaveTextContent("gpt-5.5");
		expect(best).toHaveTextContent("OpenAI (ChatGPT) · Low");
		expect(best).toHaveTextContent("€0.23–€0.92");
		expect(best).toHaveTextContent("4k tok");
		expect(within(best).getByRole("img", { name: "70% success" })).toBeInTheDocument();

		const safest = pickCard(/Safest/);
		expect(safest).toHaveTextContent("opus-5");
		expect(safest).toHaveTextContent("Anthropic (Claude) · High");

		const cheapest = pickCard(/Cheapest/);
		expect(cheapest).toHaveTextContent("llama3");
		expect(cheapest).toHaveTextContent("€0");
		expect(cheapest).toHaveTextContent("2.0M tok");
		expect(cheapest).toHaveTextContent("Flat-rate");
		expect(within(cheapest).getByText("Downloaded")).toHaveAttribute(
			"title",
			expect.stringContaining("already pulled"),
		);

		const fastest = pickCard(/Fastest/);
		expect(fastest).toHaveTextContent("qwen");
		expect(fastest).toHaveTextContent("Ollama (Local) · Med");
		expect(within(fastest).getByText("Not downloaded")).toBeInTheDocument();
		expect(best).not.toHaveTextContent("Flat-rate");
	});

	it("selecting a pick does not mark it as applied", async () => {
		await openWithMatrix();
		const best = pickCard(/Best value/);
		expect(best).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(best);

		expect(pickCard(/Best value/)).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByText("Applied")).toBeNull();
		const applyButtons = screen.getAllByRole("button", { name: "Apply" });
		expect(applyButtons).toHaveLength(4);
		for (const b of applyButtons) expect(b).toBeEnabled();

		// The footer sums up the selection.
		expect(screen.getByText("gpt-5.5 · Low")).toBeInTheDocument();
		expect(screen.getByText("OpenAI (ChatGPT) · €0.23–€0.92")).toBeInTheDocument();
	});

	it("marks the formula the task already runs on as applied, whatever its pick", async () => {
		await openWithMatrix({ appliedKey: formulaKey(OPUS) });
		const applied = screen.getByRole("button", { name: "Applied" });
		expect(applied).toBeDisabled();
		expect(pickCard(/Safest/)).toHaveAttribute("aria-pressed", "true");
		expect(screen.getAllByRole("button", { name: "Apply" })).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Apply this formula" })).toBeEnabled();
	});

	it("selects each pick from its card", async () => {
		await openWithMatrix();
		for (const [label, model] of [
			[/Safest/, "opus-5 · High"],
			[/Cheapest/, "llama3 · None"],
			[/Fastest/, "qwen · Med"],
		] as const) {
			fireEvent.click(pickCard(label));
			expect(screen.getByText(model)).toBeInTheDocument();
		}
	});

	it("applies a pick to the task, then shows it applied", async () => {
		await openWithMatrix();
		const fastest = pickCard(/Fastest/);
		const applyButton = fastest.parentElement?.querySelector(
			"button:not([aria-pressed])",
		) as HTMLButtonElement;
		fireEvent.click(applyButton);

		expect(await screen.findByText("Formula applied", TOAST)).toBeInTheDocument();
		expect(
			screen.getByText("qwen · Med will be used for every phase of this task.", TOAST),
		).toBeInTheDocument();
		expect(api.updateTask).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({
				metadata: expect.objectContaining({
					appliedFormula: expect.objectContaining({
						provider: "ollama",
						model: "qwen",
						effort: "medium",
					}),
				}),
			}),
		);
		expect(screen.getByRole("button", { name: "Applied" })).toBeDisabled();
		expect(pickCard(/Fastest/)).toHaveAttribute("aria-pressed", "true");
	});

	it("each pick's Apply applies that pick", async () => {
		await openWithMatrix();
		const applyOf = (label: RegExp) =>
			pickCard(label).parentElement?.querySelector(
				"button:not([aria-pressed])",
			) as HTMLButtonElement;
		for (const [label, model] of [
			[/Best value/, "gpt-5.5"],
			[/Safest/, "claude-opus-5-20260101"],
			[/Cheapest/, "llama3"],
		] as const) {
			fireEvent.click(applyOf(label));
			await waitFor(() =>
				expect(api.updateTask).toHaveBeenLastCalledWith(
					"task-1",
					expect.objectContaining({
						metadata: expect.objectContaining({
							appliedFormula: expect.objectContaining({ model }),
						}),
					}),
				),
			);
		}
	});

	it("says so when the task could not be saved", async () => {
		api.updateTask.mockResolvedValueOnce({ success: false, error: "disk full" });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Apply OpenAI (ChatGPT) gpt-5.5 · Low" }));

		expect(await screen.findByText("Could not apply formula", TOAST)).toBeInTheDocument();
		expect(
			screen.getByText("The task configuration was not saved. Please try again.", TOAST),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Applied" })).toBeNull();
	});

	it("disables applying while a formula is being saved", async () => {
		const saving = deferred<unknown>();
		api.updateTask.mockReturnValueOnce(saving.promise);
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Select OpenAI (ChatGPT) gpt-5.5 · Low" }));
		fireEvent.click(screen.getByRole("button", { name: "Apply this formula" }));

		expect(screen.getByRole("button", { name: "Apply this formula" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Apply OpenAI (ChatGPT) gpt-5.5 · Low" })).toBeDisabled();
		for (const b of screen.getAllByRole("button", { name: "Apply" })) {
			expect(b).toBeDisabled();
		}
		await act(async () =>
			saving.resolve({ success: true, data: { title: "Add login", description: "" } }),
		);
		expect(screen.getByRole("button", { name: "Apply this formula" })).toBeEnabled();
	});

	it("does not mark the formula applied on a ticket opened while it was saving", async () => {
		const saving = deferred<unknown>();
		api.updateTask.mockReturnValueOnce(saving.promise);
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Apply OpenAI (ChatGPT) gpt-5.5 · Low" }));
		openLab({ ticketId: "task-2", ticketTitle: "Fix logout" });
		await screen.findByRole("table");

		await act(async () =>
			saving.resolve({ success: true, data: { title: "Add login", description: "" } }),
		);
		expect(useFormulaMatrixStore.getState().appliedKey).toBeNull();
		expect(screen.queryByRole("button", { name: "Applied" })).toBeNull();
		expect(pickCard(/Best value/)).toHaveAttribute("aria-pressed", "false");
	});

	it("ranks the table by the cost ↔ confidence preference", async () => {
		await openWithMatrix();
		expect(rowModels()).toEqual(["gpt-5.5", "opus-5", "llama3", "qwen", "gemini"]);

		const slider = screen.getByRole("slider", { name: "Preference" });
		fireEvent.change(slider, { target: { value: "100" } });
		expect(rowModels()).toEqual(["opus-5", "gpt-5.5", "gemini", "llama3", "qwen"]);

		fireEvent.change(slider, { target: { value: "0" } });
		expect(rowModels()).toEqual(["llama3", "qwen", "gpt-5.5", "opus-5", "gemini"]);
	});

	it("sorts the table by each column, and back the other way", async () => {
		await openWithMatrix();
		const header = (name: string) => screen.getByRole("columnheader", { name });
		const sortBy = (name: string) =>
			fireEvent.click(within(header(name)).getByRole("button"));

		expect(header("Provider / LLM")).not.toHaveAttribute("aria-sort");

		sortBy("Provider / LLM");
		expect(header("Provider / LLM")).toHaveAttribute("aria-sort", "ascending");
		expect(rowModels()).toEqual(["opus-5", "gemini", "llama3", "qwen", "gpt-5.5"]);
		sortBy("Provider / LLM");
		expect(header("Provider / LLM")).toHaveAttribute("aria-sort", "descending");
		expect(rowModels()).toEqual(["gpt-5.5", "qwen", "llama3", "gemini", "opus-5"]);

		sortBy("Effort");
		expect(header("Provider / LLM")).not.toHaveAttribute("aria-sort");
		expect(rowModels()).toEqual(["llama3", "gpt-5.5", "qwen", "opus-5", "gemini"]);

		sortBy("Tokens");
		expect(rowModels()).toEqual(["qwen", "gpt-5.5", "opus-5", "gemini", "llama3"]);

		sortBy("Cost");
		expect(rowModels()).toEqual(["llama3", "qwen", "gpt-5.5", "opus-5", "gemini"]);

		sortBy("Success");
		expect(header("Success")).toHaveAttribute("aria-sort", "descending");
		expect(rowModels()).toEqual(["opus-5", "gpt-5.5", "gemini", "llama3", "qwen"]);
		sortBy("Success");
		expect(header("Success")).toHaveAttribute("aria-sort", "ascending");
		expect(rowModels()).toEqual(["qwen", "llama3", "gemini", "gpt-5.5", "opus-5"]);
	});

	it("shows each row's effort, tokens, cost and local state", async () => {
		await openWithMatrix();
		const row = (name: string) =>
			screen.getByRole("button", { name: `Select ${name}` }).closest("tr") as HTMLElement;

		const gemini = row("Google (Gemini) gemini · Ultra");
		expect(gemini).toHaveTextContent("Ultra");
		expect(gemini).toHaveTextContent("50k");
		expect(gemini).toHaveTextContent("€3.68–€5.52");
		expect(
			within(gemini).getByRole("img", {
				name: "Cost based on this model's real measured usage in this project",
			}),
		).toBeInTheDocument();
		expect(within(gemini).getByRole("img", { name: "AI-refined estimate" })).toHaveAttribute(
			"title",
			"Large refactor across modules",
		);

		const llama = row("Ollama (Local) llama3 · None");
		expect(within(llama).getByText("Downloaded")).toBeInTheDocument();
		expect(within(llama).queryByRole("img", { name: "AI-refined estimate" })).toBeNull();
		expect(within(row("Ollama (Local) qwen · Med")).getByText("Not downloaded")).toBeInTheDocument();
		expect(within(row("Anthropic (Claude) opus-5 · High")).queryByText(/Downloaded/)).toBeNull();
	});

	it("names an AI-refined formula even without a reason", async () => {
		api.runFormulaMatrix.mockResolvedValueOnce({
			matrix: matrixOf([{ ...GPT, ai_refined: true, refine_reason: undefined }]),
		});
		await openWithMatrix();
		expect(screen.getByRole("img", { name: "AI-refined estimate" })).toHaveAttribute(
			"title",
			"AI-refined estimate",
		);
	});

	it("selects a row by clicking it or its name", async () => {
		await openWithMatrix();
		const name = screen.getByRole("button", { name: "Select Google (Gemini) gemini · Ultra" });
		fireEvent.click(name.closest("tr")?.querySelector("td:nth-child(3)") as HTMLElement);
		expect(name).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("gemini · Ultra")).toBeInTheDocument();

		const other = screen.getByRole("button", { name: "Select Ollama (Local) qwen · Med" });
		fireEvent.click(other);
		expect(other).toHaveAttribute("aria-pressed", "true");
		expect(name).toHaveAttribute("aria-pressed", "false");
	});

	it("applies a row without selecting it first", async () => {
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Apply Google (Gemini) gemini · Ultra" }));
		expect(await screen.findByText("Formula applied", TOAST)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Select Google (Gemini) gemini · Ultra" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("filters by search, provider, effort and billing", async () => {
		await openWithMatrix();

		const search = screen.getByRole("searchbox", { name: "Search LLM…" });
		fireEvent.change(search, { target: { value: "  GPT " } });
		expect(rowModels()).toEqual(["gpt-5.5"]);
		fireEvent.change(search, { target: { value: "OLLAMA" } });
		expect(rowModels()).toEqual(["llama3", "qwen"]);
		// The provider is searched by the name the person reads.
		fireEvent.change(search, { target: { value: "chatgpt" } });
		expect(rowModels()).toEqual(["gpt-5.5"]);
		fireEvent.change(search, { target: { value: "" } });

		const provider = screen.getByRole("combobox", { name: "Provider" });
		expect(
			within(provider)
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual([
			"All providers",
			"Anthropic (Claude)",
			"Google (Gemini)",
			"Ollama (Local)",
			"OpenAI (ChatGPT)",
		]);
		fireEvent.change(provider, { target: { value: "ollama" } });
		expect(rowModels()).toEqual(["llama3", "qwen"]);
		fireEvent.change(provider, { target: { value: "all" } });

		const high = screen.getByRole("button", { name: "High", pressed: true });
		fireEvent.click(high);
		expect(high).toHaveAttribute("aria-pressed", "false");
		expect(rowModels()).not.toContain("opus-5");
		fireEvent.click(high);
		expect(rowModels()).toContain("opus-5");

		fireEvent.click(screen.getByText("Per-token only"));
		expect(screen.getByRole("switch", { name: "Per-token only" })).toBeChecked();
		expect(rowModels()).toEqual(["gpt-5.5", "opus-5", "gemini"]);
		expect(screen.getByText("3 formulas")).toBeInTheDocument();
	});

	it("keeps at least one effort level in the filter", async () => {
		await openWithMatrix();
		for (const label of ["None", "Low", "Med", "High"]) {
			fireEvent.click(screen.getByRole("button", { name: label, pressed: true }));
		}
		const ultra = screen.getByRole("button", { name: "Ultra", pressed: true });
		fireEvent.click(ultra);
		expect(ultra).toHaveAttribute("aria-pressed", "true");
		expect(rowModels()).toEqual(["gemini"]);
	});

	it("shows no picks and no chart when nothing matches", async () => {
		await openWithMatrix();
		fireEvent.change(screen.getByRole("searchbox", { name: "Search LLM…" }), {
			target: { value: "nothing-like-this" },
		});
		expect(screen.getByText("0 formulas")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Best value/ })).toBeNull();
		expect(
			screen.queryByRole("img", {
				name: "Efficiency frontier: cost versus success probability",
			}),
		).toBeNull();
		expect(rowModels()).toEqual([]);
	});

	it("hides the summary of a selection that is filtered out", async () => {
		await openWithMatrix({ appliedKey: formulaKey(OPUS) });
		expect(screen.getByRole("button", { name: "Apply this formula" })).toBeInTheDocument();
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), {
			target: { value: "openai" },
		});
		expect(screen.queryByRole("button", { name: "Apply this formula" })).toBeNull();
	});

	it("caps the table and says how many formulas are left out", async () => {
		const many = Array.from({ length: 501 }, (_, i) =>
			formula({ model: `model-${i}`, expected_cost_usd: i / 100 }),
		);
		api.runFormulaMatrix.mockResolvedValueOnce({ matrix: matrixOf(many) });
		await openWithMatrix();
		expect(
			screen.getByText("+1 more formulas (refine the filters to narrow down)"),
		).toBeInTheDocument();
		expect(rowModels()).toHaveLength(500);
	});

	it("selects a formula from the efficiency frontier, by mouse or keyboard", async () => {
		await openWithMatrix();
		const chart = screen.getByRole("img", {
			name: "Efficiency frontier: cost versus success probability",
		});
		const point = (name: RegExp) => within(chart).getByRole("button", { name });

		fireEvent.click(point(/^Google \(Gemini\) gemini · Ultra/));
		expect(screen.getByText("gemini · Ultra")).toBeInTheDocument();

		fireEvent.keyDown(point(/^Ollama \(Local\) qwen · Med/), { key: "Enter" });
		expect(screen.getByText("qwen · Med")).toBeInTheDocument();

		fireEvent.keyDown(point(/^OpenAI \(ChatGPT\) gpt-5\.5 · Low/), { key: " " });
		expect(screen.getByText("gpt-5.5 · Low")).toBeInTheDocument();

		fireEvent.keyDown(point(/^Anthropic \(Claude\) opus-5 · High/), { key: "Tab" });
		expect(screen.getByText("gpt-5.5 · Low")).toBeInTheDocument();
	});

	it("refines the top three formulas with AI and marks them", async () => {
		const answer = deferred<{ refined: unknown[] }>();
		api.refineFormulas.mockReturnValueOnce(answer.promise);
		await openWithMatrix();

		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
		expect(screen.getByRole("button", { name: "Refining…" })).toBeDisabled();
		expect(api.refineFormulas).toHaveBeenCalledWith({
			description: "Let people sign in",
			candidates: [GPT, OPUS, LLAMA].map((f) =>
				expect.objectContaining({
					key: formulaKey(f),
					model: f.model,
					base_probability: f.success_probability,
				}),
			),
		});

		await act(async () =>
			answer.resolve({
				refined: [
					{ key: formulaKey(OPUS), success_probability: 0.97, reason: "Fits a flagship" },
				],
			}),
		);
		expect(screen.getByRole("button", { name: "Refine with AI" })).toBeEnabled();
		const opusRow = screen
			.getByRole("button", { name: "Select Anthropic (Claude) opus-5 · High" })
			.closest("tr") as HTMLElement;
		expect(within(opusRow).getByRole("img", { name: "97% success" })).toBeInTheDocument();
		expect(within(opusRow).getByRole("img", { name: "AI-refined estimate" })).toHaveAttribute(
			"title",
			"Fits a flagship",
		);
	});

	it("says so when the AI refine gives nothing back or fails", async () => {
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
		expect(await screen.findByText(/AI confidence refine unavailable/)).toBeInTheDocument();

		api.refineFormulas.mockRejectedValueOnce(new Error("quota"));
		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
		await waitFor(() => expect(useFormulaMatrixStore.getState().refineError).toBe("quota"));
		expect(screen.getByText(/AI confidence refine unavailable/)).toBeInTheDocument();

		api.refineFormulas.mockRejectedValueOnce("offline");
		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));
		await waitFor(() => expect(useFormulaMatrixStore.getState().refineError).toBe("offline"));
		expect(screen.getByRole("button", { name: "Refine with AI" })).toBeEnabled();
	});

	it("drops an AI refine answer for a ticket the lab is no longer open on", async () => {
		const answer = deferred<{ refined: unknown[] }>();
		const failure = deferred<{ refined: unknown[] }>();
		api.refineFormulas
			.mockReturnValueOnce(answer.promise)
			.mockReturnValueOnce(failure.promise);
		api.runFormulaMatrix
			.mockResolvedValueOnce({ matrix: matrixOf(ALL) })
			.mockResolvedValueOnce({ matrix: matrixOf([GPT, OPUS]) })
			.mockResolvedValueOnce({ matrix: matrixOf([GPT]) });
		await openWithMatrix();
		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));

		openLab({ ticketId: "task-2", ticketTitle: "Fix logout" });
		await waitFor(() => expect(rowModels()).toEqual(["gpt-5.5", "opus-5"]));
		expect(screen.getByRole("button", { name: "Refine with AI" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "Refine with AI" }));

		await act(async () =>
			answer.resolve({
				refined: [{ key: formulaKey(OPUS), success_probability: 0.1, reason: "stale" }],
			}),
		);
		expect(screen.queryByRole("img", { name: "AI-refined estimate" })).toBeNull();
		expect(screen.getByRole("button", { name: "Refining…" })).toBeDisabled();

		openLab({ ticketId: "task-3", ticketTitle: "Third" });
		await waitFor(() => expect(rowModels()).toEqual(["gpt-5.5"]));
		await act(async () => failure.reject(new Error("stale failure")));
		expect(screen.queryByText(/AI confidence refine unavailable/)).toBeNull();
		expect(screen.getByRole("button", { name: "Refine with AI" })).toBeEnabled();
	});

	it("closes and forgets the ticket", async () => {
		await openWithMatrix({ appliedKey: formulaKey(GPT) });
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const state = useFormulaMatrixStore.getState();
		expect(state.isOpen).toBe(false);
		expect(state.matrix).toBeNull();
		expect(state.appliedKey).toBeNull();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		await openWithMatrix();
		expect(screen.getByRole("button", { name: /Meilleur rapport/ })).toHaveTextContent(
			"OpenAI (ChatGPT) · Faible",
		);
		expect(screen.getAllByRole("img", { name: "70 % de réussite" }).length).toBeGreaterThan(0);
		expect(screen.getByRole("combobox", { name: "Fournisseur" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Appliquer Google (Gemini) gemini · Ultra" }),
		).toBeInTheDocument();
	});
});
