/** @vitest-environment jsdom */
/**
 * The domain agents of the project, and the model router.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import { bindPhase35Project } from "../../../stores/phase35-stores";
import { DomainAgentsPanel } from "../DomainAgentsPanel";
import { ModelRouterPanel } from "../ModelRouterPanel";
import { type Api, deferred, openWorld } from "./phase35-world";

let api: Api;
beforeEach(async () => {
	api = await openWorld({
		listDomains: async () => ({
			success: true,
			domains: [
				{ tag: "fintech", label: "Fintech", description: "Money" },
				{ tag: "space", label: "Space", description: "Rockets and orbits." },
			],
		}),
		getProjectDomain: async () => ({ success: true, domain: null, languages: [] }),
	});
});
afterEach(cleanup);

const BUNDLE = {
	domain: "space",
	role: "planner",
	profile: {},
	prompt_addendum: "Never trust a single sensor.",
	required_skills: ["orbital-math"],
	guardrails: ["Check units twice"],
	forbidden_patterns: ["eval("],
	validation_rules: ["Telemetry is logged"],
	suggested_libraries: { python: ["astropy", "poliastro"] },
};

describe("DomainAgentsPanel", () => {
	it("builds the bundle of the picked domain and role for the project", async () => {
		api.buildDomainBundle.mockResolvedValue({ success: true, bundle: BUNDLE });
		render(<DomainAgentsPanel projectPath="/work/rocket" />);
		const domain = screen.getByLabelText("Domain") as HTMLSelectElement;
		await waitFor(() => expect(domain.value).toBe("fintech"));
		expect(screen.getByText("No domain applied to this project: tasks get no domain addendum.")).toBeInTheDocument();
		expect(screen.getByText("No stack detected: libraries for every stack are listed.")).toBeInTheDocument();
		// A domain the app has no words for keeps the backend's label and description.
		fireEvent.change(domain, { target: { value: "space" } });
		expect(screen.getByRole("option", { name: "Space" })).toBeInTheDocument();
		expect(screen.getByText("Rockets and orbits.")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Agent role"), { target: { value: "planner" } });
		fireEvent.click(screen.getByRole("button", { name: "Build bundle" }));
		expect(await screen.findByText("Guardrails (1)")).toBeInTheDocument();
		expect(api.buildDomainBundle).toHaveBeenCalledWith("space", "planner", "/work/rocket");
		expect(screen.getByText("Check units twice")).toBeInTheDocument();
		expect(screen.getByText("Required skills (1)")).toBeInTheDocument();
		expect(screen.getByText("Forbidden patterns (1)")).toBeInTheDocument();
		expect(screen.getByText("Validation rules (1)")).toBeInTheDocument();
		expect(screen.getByText("python: astropy, poliastro")).toBeInTheDocument();
		expect(screen.getByText("Never trust a single sensor.")).toBeInTheDocument();
	});

	it("builds without a project, and shows an empty bundle's prompt only", async () => {
		api.buildDomainBundle.mockResolvedValue({
			success: true,
			bundle: {
				...BUNDLE,
				required_skills: [],
				guardrails: [],
				forbidden_patterns: [],
				validation_rules: [],
				suggested_libraries: {},
			},
		});
		render(<DomainAgentsPanel />);
		expect(screen.getByText(/Open a project to apply a domain/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByLabelText("Domain")).toHaveValue("fintech"));
		fireEvent.click(screen.getByRole("button", { name: "Build bundle" }));
		expect(await screen.findByText("Generated prompt addendum")).toBeInTheDocument();
		expect(api.buildDomainBundle).toHaveBeenCalledWith("fintech", "coder", undefined);
		expect(screen.queryByText(/Guardrails/)).not.toBeInTheDocument();
		expect(screen.queryByText("Suggested libraries for this project")).not.toBeInTheDocument();
	});

	it("removes the project's domain", async () => {
		api.getProjectDomain.mockResolvedValue({ success: true, domain: "lost_domain", languages: ["go"] });
		api.setProjectDomain.mockResolvedValue({ success: true, domain: null });
		render(<DomainAgentsPanel projectPath="/work/rocket" />);
		// Its tag is not in the list: the panel names it by its tag.
		expect(await screen.findByText("Domain applied to this project: lost_domain")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Remove from project" }));
		await waitFor(() => expect(api.setProjectDomain).toHaveBeenCalledWith("/work/rocket", null));
		expect(await screen.findByText(/No domain applied to this project/)).toBeInTheDocument();
	});

	it("says when no domain could be loaded", async () => {
		api.listDomains.mockResolvedValue({ success: false, error: "fetch failed" });
		render(<DomainAgentsPanel />);
		expect(await screen.findByText("No domains available — check the backend connection.")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Backend unreachable");
		expect(screen.getByRole("option", { name: "—" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Build bundle" })).toBeDisabled();
	});

	it("asks for a domain when none is picked", async () => {
		render(<DomainAgentsPanel />);
		const domain = screen.getByLabelText("Domain");
		await waitFor(() => expect(domain).toHaveValue("fintech"));
		fireEvent.change(domain, { target: { value: "" } });
		expect(screen.getByText("Select a domain")).toBeInTheDocument();
	});

	it("drops a bundle built for the project that was open before", async () => {
		const late = deferred<unknown>();
		api.buildDomainBundle.mockReturnValue(late.promise);
		bindPhase35Project("/work/rocket");
		render(<DomainAgentsPanel projectPath="/work/rocket" />);
		await waitFor(() => expect(screen.getByLabelText("Domain")).toHaveValue("fintech"));
		fireEvent.click(screen.getByRole("button", { name: "Build bundle" }));
		expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
		act(() => bindPhase35Project("/work/bank"));
		await act(async () => late.resolve({ success: true, bundle: BUNDLE }));
		expect(screen.queryByText("Generated prompt addendum")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Build bundle" })).toBeEnabled();
	});

	it("drops a failure of the project that was open before", async () => {
		const late = deferred<unknown>();
		api.buildDomainBundle.mockImplementation(async () => {
			await late.promise;
			throw new Error("too late");
		});
		bindPhase35Project("/work/rocket");
		render(<DomainAgentsPanel projectPath="/work/rocket" />);
		await waitFor(() => expect(screen.getByLabelText("Domain")).toHaveValue("fintech"));
		fireEvent.click(screen.getByRole("button", { name: "Build bundle" }));
		act(() => bindPhase35Project("/work/bank"));
		await act(async () => late.resolve(undefined));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Build bundle" })).toBeEnabled();
	});
});

const choice = (over: Record<string, unknown> = {}) => ({
	provider: "anthropic",
	model: "claude-haiku",
	task_class: "trivial",
	tier: "budget",
	estimated_cost_usd: 0.000123,
	reason: "English reason for the audit trail",
	...over,
});

describe("ModelRouterPanel", () => {
	it("asks for a prompt and a provider before routing", () => {
		render(<ModelRouterPanel />);
		expect(screen.getByText("Enter a prompt to route")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Remove Anthropic" }));
		expect(screen.getByText("Pick at least one provider")).toBeInTheDocument();
		expect(screen.getByText("Select providers to compare")).toBeInTheDocument();
	});

	it("routes a prompt on the picked providers and words why", async () => {
		api.routeModel.mockResolvedValue({
			success: true,
			choice: choice({
				reason_code: "tier_for_task",
				reason_params: { bench_resolved: 3, bench_judged: 4, passed_over: ["gpt-x"] },
			}),
		});
		render(<ModelRouterPanel />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: " rename foo " } });
		fireEvent.change(screen.getByLabelText("Task type"), { target: { value: "review" } });
		fireEvent.click(screen.getByRole("button", { name: /1 selected/ }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "OpenAI" }));
		expect(screen.getByRole("button", { name: /2 selected/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(screen.getAllByText("Select all")).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Mistral" }));
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(await screen.findByText(/Chosen model/)).toBeInTheDocument();
		expect(api.routeModel).toHaveBeenCalledWith({ prompt: "rename foo", hint: "review", available: ["mistral"] });
		expect(screen.getByText("claude-haiku")).toBeInTheDocument();
		expect(within(screen.getByText(/Chosen model/).parentElement as HTMLElement).getByText("Anthropic")).toBeInTheDocument();
		expect(screen.getByText(/Estimated cost \(USD\): \$0\.000123/)).toBeInTheDocument();
		expect(
			screen.getByText(
				"Reason: Budget tier for a trivial change Replay bench: 3/4 cards resolved. Passed over on replay bench evidence: gpt-x.",
			),
		).toBeInTheDocument();
	});

	it.each([
		[{ reason_code: "unpriced_provider", reason_params: { billing: "local" }, provider: "ollama" }, "Ollama (local) runs locally"],
		[{ reason_code: "no_model", model: "", provider: "lab" }, "No catalog model for lab"],
		[
			{ reason_code: "no_model", reason_params: { providers: ["openai", "lab"] } },
			"No catalog model for OpenAI, lab",
		],
		[{ reason_code: "unpriced_provider", provider: "copilot" }, "GitHub Copilot is billed by subscription"],
		[{ reason_code: "fallback" }, "No available provider has a known price"],
		[{ tier: "ultra", task_class: "chores" }, "English reason for the audit trail"],
	])("words the reason %#", async (over, words) => {
		api.routeModel.mockResolvedValue({ success: true, choice: choice(over) });
		render(<ModelRouterPanel />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(await screen.findByText(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
	});

	it("shows a provider the panel does not list by its id, and an unknown tier as sent", async () => {
		api.routeModel.mockResolvedValue({
			success: true,
			choice: choice({ provider: "lab", model: "", tier: "ultra", task_class: "chores" }),
		});
		render(<ModelRouterPanel />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: "Run" }));
		expect(await screen.findByText("lab")).toBeInTheDocument();
		expect(screen.getByText(/no model to suggest \(\s*ultra · chores\s*\)/)).toBeInTheDocument();
	});

	it("compares the tiers, in euros in French", async () => {
		api.compareModels.mockResolvedValue({
			success: true,
			by_tier: {
				budget: choice({ provider: "copilot", model: "gpt-mini", estimated_cost_usd: 2 }),
				premium: choice({ model: "" }),
				galaxy: choice({ provider: "lab", model: "m", estimated_cost_usd: 1 }),
			},
		});
		const { unmount } = render(<ModelRouterPanel />);
		fireEvent.change(screen.getByLabelText("Task prompt"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: "Compare across tiers" }));
		expect(await screen.findByText("GitHub Copilot · gpt-mini")).toBeInTheDocument();
		expect(screen.getByText("$2.000000")).toBeInTheDocument();
		expect(screen.getByText("no model to suggest")).toBeInTheDocument();
		expect(screen.getByText("galaxy")).toBeInTheDocument();
		expect(screen.getByText("lab · m")).toBeInTheDocument();
		unmount();

		await act(async () => {
			await i18n.changeLanguage("fr");
		});
		render(<ModelRouterPanel />);
		expect(screen.getByText("Économique")).toBeInTheDocument();
		expect(await screen.findByText("1.000000 €")).toBeInTheDocument();
	});
});
