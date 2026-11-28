/**
 * Auto-compose: the page sends what the person chose, shows the suggested
 * crew (and the cheaper one a budget asks for), and creates nothing until the
 * crew is applied.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	MissionControlComposition,
	MissionControlPlannedAgent,
} from "../../../../shared/types/mission-control";
import { useProjectStore } from "../../../stores/project-store";
import { useTaskStore } from "../../../stores/task-store";
import { AutoComposePanel } from "../AutoComposePanel";

const agent = (over: Partial<MissionControlPlannedAgent>): MissionControlPlannedAgent => ({
	key: "coder-1",
	role: "coder",
	critical: false,
	optional: false,
	provider: "anthropic",
	model: "m-standard",
	model_label: "Model Standard",
	tier: "standard",
	input_tokens: 1000,
	output_tokens: 500,
	cost_usd: 0.25,
	flat_rate: false,
	tool_use: null,
	context_window: 200_000,
	...over,
});

const crew = (agents: MissionControlPlannedAgent[], cost: number, quality = 1) => ({
	agents,
	cost_usd: cost,
	tokens: 12_345,
	unpriced: 0,
	quality,
});

const signals = {
	words: 10,
	spec_tokens: 10,
	touched_files: 0,
	domains: [],
	has_test_suite: false,
	languages: [],
	kind: "bug_fix",
	has_spec: false,
};

const DEGRADED: MissionControlComposition = {
	status: "degraded",
	template: "bug_fix",
	template_source: "chosen",
	complexity: "medium",
	signals,
	hinted: false,
	warnings: [
		{ code: "vague_input", params: {} },
		{ code: "role_unserved", params: { role: "tester" } },
		{ code: "provider_unsupported", params: { provider: "zzz-unknown" } },
	],
	budget: { usd: 0.5, tokens: null },
	full: crew([agent({})], 1),
	proposed: crew(
		[
			agent({ key: "debugger-1", role: "debugger", provider: "openai" }),
			agent({ key: "coder-1", model_label: "", tier: "provider_default", cost_usd: null }),
			agent({ key: "tester-1", role: "tester", provider: "ollama", flat_rate: true, cost_usd: 0 }),
		],
		0.4,
		0.8,
	),
	minimum: null,
	steps: ["non_critical_fast"],
	changes: [
		{ key: "coder-2", role: "coder", kind: "dropped" },
		{
			key: "coder-1",
			role: "coder",
			kind: "model",
			from: agent({}),
			to: agent({ model_label: "" }),
		},
	],
};

let suggest: ReturnType<typeof vi.fn>;

beforeEach(() => {
	suggest = vi.fn().mockResolvedValue({ success: true, data: DEGRADED });
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		missionControlSuggestComposition: suggest,
	};
	useProjectStore.setState({ selectedProjectId: "p1" });
	useTaskStore.setState({
		tasks: [
			{ id: "t1", specId: "001-login", projectId: "p1", title: "Login crash" },
			{ id: "t2", specId: "002-other", projectId: "p2", title: "Elsewhere" },
		] as never,
	});
});
afterEach(cleanup);

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

describe("AutoComposePanel", () => {
	it("sends the choices and shows the cheaper crew, then applies it", async () => {
		const onApply = vi.fn().mockResolvedValue(undefined);
		render(<AutoComposePanel defaultProvider="anthropic" onApply={onApply} />);

		click("Bug fix");
		fireEvent.change(screen.getByLabelText("Work to do"), {
			target: { value: "Fix the login crash" },
		});
		fireEvent.change(screen.getByLabelText("Spec of a task"), {
			target: { value: "001-login" },
		});
		expect(screen.queryByRole("option", { name: "Elsewhere" })).toBeNull();
		click("OpenAI (ChatGPT)");
		expect(screen.getByText(/Order of preference/)).toHaveTextContent("→");
		fireEvent.change(screen.getByLabelText("Maximum budget", { selector: "input" }), {
			target: { value: "0.5" },
		});
		fireEvent.click(screen.getByRole("checkbox"));
		click("Suggest a crew");

		await screen.findByTestId("mc-composition");
		expect(suggest).toHaveBeenCalledWith({
			prompt: "Fix the login crash",
			providers: ["anthropic", "openai"],
			refine: true,
			template: "bug_fix",
			projectId: "p1",
			specId: "001-login",
			budgetUsd: 0.5,
		});
		expect(screen.getByText(/Template: Bug fix · size: medium/)).toBeInTheDocument();
		expect(screen.getByText(/too vague/)).toBeInTheDocument();
		expect(screen.getByText(/the Tester role/)).toBeInTheDocument();
		expect(screen.getByText(/zzz-unknown cannot run an agent/)).toBeInTheDocument();
		expect(screen.getByText(/saves \$0\.6000, expected quality 80 %/)).toBeInTheDocument();
		expect(screen.getByText("Coder left out")).toBeInTheDocument();
		expect(
			screen.getByText("Coder: Model Standard → Model chosen by the provider"),
		).toBeInTheDocument();
		expect(screen.getByText("price unknown")).toBeInTheDocument();
		expect(screen.getByText("no token price")).toBeInTheDocument();
		expect(screen.getByText("$0.2500")).toBeInTheDocument();
		expect(screen.getByText(/Estimated: \$0\.4000/)).toBeInTheDocument();

		click("Create 3 agents");
		// The session learns the providers in order and the budget of the crew.
		await waitFor(() =>
			expect(onApply).toHaveBeenCalledWith(DEGRADED.proposed?.agents, {
				providers: ["anthropic", "openai"],
				budgetUsd: 0.5,
			}),
		);
	});

	it("refuses a budget that is not a number without asking", () => {
		render(<AutoComposePanel defaultProvider="anthropic" onApply={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("Maximum budget", { selector: "input" }), {
			target: { value: "lots" },
		});
		click("Suggest a crew");
		expect(screen.getByRole("alert")).toHaveTextContent("positive number");
		expect(suggest).not.toHaveBeenCalled();
	});

	it("sends a token budget and shows a refusal with the minimum", async () => {
		useProjectStore.setState({ selectedProjectId: null });
		suggest.mockResolvedValue({
			success: true,
			data: {
				...DEGRADED,
				status: "refused",
				warnings: [],
				proposed: null,
				changes: [],
				minimum: crew([agent({})], 0.3),
			},
		});
		render(<AutoComposePanel defaultProvider="ollama" onApply={vi.fn()} />);
		expect(screen.queryByLabelText("Spec of a task")).toBeNull();
		fireEvent.change(screen.getByLabelText("Maximum budget", { selector: "input" }), {
			target: { value: "1000.4" },
		});
		fireEvent.change(screen.getByLabelText("Maximum budget", { selector: "select" }), {
			target: { value: "tokens" },
		});
		click("Suggest a crew");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"even the smallest crew needs $0.3000",
		);
		expect(suggest).toHaveBeenCalledWith({
			prompt: "",
			providers: ["ollama"],
			refine: false,
			budgetTokens: 1000,
		});
		expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
	});

	it.each([
		[{ success: false, error: "no_provider" }, "None of the chosen providers"],
		[{ success: false, error: "HTTP 500" }, "Could not suggest a crew: HTTP 500"],
		[{ success: false }, "Could not suggest a crew:"],
	])("words a refusal (%j)", async (response, text) => {
		suggest.mockResolvedValue(response);
		render(<AutoComposePanel defaultProvider="anthropic" onApply={vi.fn()} />);
		click("Suggest a crew");
		expect(await screen.findByRole("alert")).toHaveTextContent(text);
		expect(screen.queryByTestId("mc-composition")).toBeNull();
	});

	it("cannot suggest without a provider", () => {
		render(<AutoComposePanel defaultProvider="anthropic" onApply={vi.fn()} />);
		click("Anthropic (Claude)");
		expect(screen.queryByText(/Order of preference/)).toBeNull();
		expect(screen.getByRole("button", { name: "Suggest a crew" })).toBeDisabled();
	});

	it("says which estimates history calibrated, and hands a token budget to the session", async () => {
		suggest.mockResolvedValue({
			success: true,
			data: { ...DEGRADED, budget: { usd: null, tokens: 5000 }, calibrated: ["coder", "tester"] },
		});
		const onApply = vi.fn().mockResolvedValue(undefined);
		render(<AutoComposePanel defaultProvider="anthropic" onApply={onApply} />);
		click("Suggest a crew");
		expect(await screen.findByTestId("mc-composition-calibrated")).toHaveTextContent(
			"calibrated on your past sessions for: Coder, Tester",
		);
		click("Create 3 agents");
		await waitFor(() =>
			expect(onApply).toHaveBeenCalledWith(DEGRADED.proposed?.agents, {
				providers: ["anthropic"],
				budgetTokens: 5000,
			}),
		);
	});
});
