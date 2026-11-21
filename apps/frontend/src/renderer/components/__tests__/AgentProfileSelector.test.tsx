/**
 * @vitest-environment jsdom
 */
/**
 * The agent profile picker of the task forms: the presets in the person's
 * language, the per-phase models and thinking levels, the custom mode, and the
 * migration of saved models onto what the active provider offers.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BALANCED_PHASE_MODELS,
	BALANCED_PHASE_THINKING,
	COMPLEX_PHASE_MODELS,
	COMPLEX_PHASE_THINKING,
} from "../../../shared/constants";
import i18n from "../../../shared/i18n";
import type { LocalBackendResponse } from "../../../shared/types/local-backend";
import { AgentProfileSelector } from "../AgentProfileSelector";
import { ProviderContext } from "../ProviderContext";

const CANONICAL = {
	spec: "claude-sonnet-5-5",
	planning: "claude-sonnet-5-5",
	coding: "claude-sonnet-5-5",
	qa: "claude-sonnet-5-5",
};

/** What the local backend answers for each provider's model catalog. */
let answers: Record<string, () => Promise<LocalBackendResponse>> = {};
const localBackendRequest = vi.fn(({ url }: { url: string }) => {
	const provider = /\/providers\/models\/([^/]+)\//.exec(url)?.[1] ?? "";
	return answers[provider]?.() ?? Promise.resolve({ unreachable: true } as const);
});

function json(body: unknown): Promise<LocalBackendResponse> {
	return Promise.resolve({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify(body),
	});
}

type Props = ComponentProps<typeof AgentProfileSelector>;

function renderSelector(props: Partial<Props> = {}, selectedProvider = "") {
	const all: Props = {
		profileId: "balanced",
		model: "",
		thinkingLevel: "",
		phaseModels: CANONICAL,
		phaseThinking: BALANCED_PHASE_THINKING,
		onProfileChange: vi.fn(),
		onModelChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onPhaseModelsChange: vi.fn(),
		onPhaseThinkingChange: vi.fn(),
		...props,
	};
	const context = {
		selectedProvider,
		setSelectedProvider: vi.fn(),
		usageProvider: "",
		usageProviderChoice: null,
		setUsageProviderChoice: vi.fn(),
		runningProviders: [],
	};
	const view = render(
		<ProviderContext.Provider value={context}>
			<AgentProfileSelector {...all} />
		</ProviderContext.Provider>,
	);
	return { ...view, props: all };
}

async function pick(trigger: HTMLElement, name: string | RegExp) {
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name }));
}

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	answers = {};
	localBackendRequest.mockClear();
	Object.assign(globalThis.electronAPI, { localBackendRequest });
});

afterEach(async () => {
	await i18n.changeLanguage("en");
});

describe("AgentProfileSelector presets", () => {
	it("shows the chosen preset and offers every preset with its model and thinking level", async () => {
		renderSelector({ profileId: "complex", phaseModels: COMPLEX_PHASE_MODELS });
		const trigger = screen.getByRole("combobox", { name: "Agent Profile" });
		expect(trigger).toHaveTextContent("Complex Tasks");
		expect(
			screen.getByText("For intricate, multi-step implementations requiring deep analysis"),
		).toBeInTheDocument();

		fireEvent.keyDown(trigger, { key: "Enter" });
		expect(await screen.findByRole("option", { name: /Auto \(Optimized\)/ })).toHaveTextContent(
			"(Claude Opus 5.5 + High)",
		);
		expect(screen.getByRole("option", { name: /Complex Tasks/ })).toHaveTextContent(
			"(Claude Opus 5.5 + Ultra Think)",
		);
		expect(screen.getByRole("option", { name: /Balanced/ })).toHaveTextContent(
			"(Claude Sonnet 5.5 + Medium)",
		);
		expect(screen.getByRole("option", { name: /Quick Edits/ })).toHaveTextContent(
			"(Claude Haiku 5.5 + Low)",
		);
		expect(screen.getByRole("option", { name: /Custom/ })).toHaveTextContent(
			"Choose specific model and thinking level",
		);
	});

	it("names the presets and their thinking levels in French", async () => {
		await i18n.changeLanguage("fr");
		renderSelector({ profileId: "quick" });
		const trigger = screen.getByRole("combobox", { name: "Profil d'Agent" });
		expect(trigger).toHaveTextContent("Modifications rapides");
		fireEvent.keyDown(trigger, { key: "Enter" });
		expect(await screen.findByRole("option", { name: /Tâches complexes/ })).toHaveTextContent(
			"(Claude Opus 5.5 + Ultra Think)",
		);
		expect(screen.getByRole("option", { name: /Équilibré/ })).toHaveTextContent(
			"(Claude Sonnet 5.5 + Moyen)",
		);
	});

	it("says which model the auto profile runs on, and shows auto for an unknown profile", () => {
		const { unmount } = renderSelector({ profileId: "auto" });
		expect(
			screen.getByText("Uses Claude Opus 5.5 across all phases with optimized thinking levels"),
		).toBeInTheDocument();
		unmount();

		renderSelector({ profileId: "retired-profile" });
		expect(screen.getByRole("combobox", { name: "Agent Profile" })).toHaveTextContent(
			"Auto (Optimized)",
		);
	});

	it("applies a preset with its phase models and thinking levels", async () => {
		const { props } = renderSelector();
		await pick(screen.getByRole("combobox", { name: "Agent Profile" }), /Complex Tasks/);
		expect(props.onProfileChange).toHaveBeenCalledWith("complex", "opus", "ultrathink");
		expect(props.onPhaseModelsChange).toHaveBeenCalledWith(COMPLEX_PHASE_MODELS);
		expect(props.onPhaseThinkingChange).toHaveBeenCalledWith(COMPLEX_PHASE_THINKING);
	});

	it("applies a preset when the form keeps no phase configuration", async () => {
		const { props } = renderSelector({
			onPhaseModelsChange: undefined,
			onPhaseThinkingChange: undefined,
		});
		await pick(screen.getByRole("combobox", { name: "Agent Profile" }), /Quick Edits/);
		expect(props.onProfileChange).toHaveBeenCalledWith("quick", "haiku", "low");
	});

	it("switches to custom with defaults when nothing is chosen yet", async () => {
		const { props } = renderSelector();
		await pick(screen.getByRole("combobox", { name: "Agent Profile" }), /Custom/);
		expect(props.onProfileChange).toHaveBeenCalledWith("custom", "sonnet", "medium");
	});

	it("switches to custom keeping the current model and thinking level", async () => {
		const { props } = renderSelector({
			model: "claude-opus-5-5",
			thinkingLevel: "high",
		});
		await pick(screen.getByRole("combobox", { name: "Agent Profile" }), /Custom/);
		expect(props.onProfileChange).toHaveBeenCalledWith("custom", "claude-opus-5-5", "high");
	});

	it("cannot be changed while disabled", () => {
		renderSelector({ disabled: true });
		expect(screen.getByRole("combobox", { name: "Agent Profile" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /Phase Configuration/ })).toBeDisabled();
	});
});

describe("AgentProfileSelector phases", () => {
	it("summarises each phase's model, and shows a model the catalog does not know as saved", () => {
		renderSelector({ phaseModels: { ...CANONICAL, qa: "my-own-model" } });
		const summary = screen.getByText("Spec Creation:").closest("div")?.parentElement as HTMLElement;
		expect(within(summary).getAllByText("Sonnet 5.5")).toHaveLength(3);
		expect(within(summary).getByText("my-own-model")).toBeInTheDocument();
		expect(screen.getByText("Click to customize")).toBeInTheDocument();
	});

	it("falls back to the default phase configuration", () => {
		renderSelector({ phaseModels: undefined, phaseThinking: undefined });
		fireEvent.click(screen.getByRole("button", { name: /Phase Configuration/ }));
		expect(screen.getAllByRole("combobox", { name: "Thinking" })[0]).toHaveTextContent("Medium");
	});

	it("edits a phase's model and thinking level, then folds back", async () => {
		const { props } = renderSelector();
		fireEvent.click(screen.getByRole("button", { name: /Phase Configuration/ }));
		expect(screen.queryByText("Click to customize")).not.toBeInTheDocument();
		expect(screen.getByText("Discovery, requirements, context gathering")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh the model list" })).toBeInTheDocument();

		const models = screen.getAllByRole("combobox", { name: "Model" });
		expect(models).toHaveLength(4);
		expect(models[0]).toHaveAccessibleDescription("Spec Creation");
		await pick(models[0], "Claude Opus 5.5");
		expect(props.onPhaseModelsChange).toHaveBeenCalledWith({
			...CANONICAL,
			spec: "claude-opus-5-5",
		});

		const thinking = screen.getAllByRole("combobox", { name: "Thinking" });
		expect(thinking[3]).toHaveAccessibleDescription("QA Review");
		await pick(thinking[3], "Ultra Think");
		expect(props.onPhaseThinkingChange).toHaveBeenCalledWith({
			...BALANCED_PHASE_THINKING,
			qa: "ultrathink",
		});

		fireEvent.click(screen.getByRole("button", { name: /Phase Configuration/ }));
		expect(screen.getByText("Click to customize")).toBeInTheDocument();
	});

	it("lets a phase be picked when the form keeps no phase configuration", async () => {
		const { props } = renderSelector({
			onPhaseModelsChange: undefined,
			onPhaseThinkingChange: undefined,
		});
		fireEvent.click(screen.getByRole("button", { name: /Phase Configuration/ }));
		await pick(screen.getAllByRole("combobox", { name: "Model" })[1], "Claude Haiku 5.5");
		await pick(screen.getAllByRole("combobox", { name: "Thinking" })[1], "Low");
		expect(props.onProfileChange).not.toHaveBeenCalled();
	});
});

describe("AgentProfileSelector custom mode", () => {
	it("picks a model and a thinking level described in words", async () => {
		const { props } = renderSelector({
			profileId: "custom",
			model: "claude-sonnet-5-5",
			thinkingLevel: "medium",
		});
		const trigger = screen.getByRole("combobox", { name: "Agent Profile" });
		expect(trigger).toHaveTextContent("Custom Configuration");
		expect(screen.queryByRole("button", { name: /Phase Configuration/ })).not.toBeInTheDocument();

		await pick(screen.getByRole("combobox", { name: "Model" }), "Claude Haiku 5.5");
		expect(props.onModelChange).toHaveBeenCalledWith("claude-haiku-5-5");

		const thinking = screen.getByRole("combobox", { name: "Thinking" });
		fireEvent.keyDown(thinking, { key: "Enter" });
		const deep = await screen.findByRole("option", { name: /High/ });
		expect(deep).toHaveTextContent("High- Deep thinking");
		fireEvent.click(deep);
		expect(props.onThinkingLevelChange).toHaveBeenCalledWith("high");
	});

	it("asks for a model and a thinking level when none is set", () => {
		renderSelector({ profileId: "custom" });
		expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent("Select a model");
		expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
			"Select thinking level",
		);
	});
});

describe("AgentProfileSelector provider migration", () => {
	it("rewrites legacy aliases onto the provider's catalog entries", async () => {
		const { props } = renderSelector({ phaseModels: BALANCED_PHASE_MODELS });
		await waitFor(() => expect(props.onPhaseModelsChange).toHaveBeenCalledWith(CANONICAL));
	});

	it("leaves models the catalog already offers, and phases nobody can change", () => {
		const first = renderSelector();
		expect(first.props.onPhaseModelsChange).not.toHaveBeenCalled();
		first.unmount();
		const second = renderSelector({
			phaseModels: BALANCED_PHASE_MODELS,
			onPhaseModelsChange: undefined,
		});
		expect(second.props.onModelChange).not.toHaveBeenCalled();
	});

	it("rewrites the custom model, and only in custom mode", async () => {
		const custom = renderSelector({ profileId: "custom", model: "opus" });
		await waitFor(() => expect(custom.props.onModelChange).toHaveBeenCalledWith("claude-opus-5-5"));
		custom.unmount();

		for (const props of [
			{ profileId: "custom", model: "claude-opus-5-5" },
			{ profileId: "custom", model: "" },
			{ profileId: "balanced", model: "opus" },
		]) {
			const view = renderSelector(props);
			expect(view.props.onModelChange).not.toHaveBeenCalled();
			view.unmount();
		}
	});

	it("waits for the live catalog of the provider before migrating", async () => {
		let answer: (value: LocalBackendResponse) => void = () => undefined;
		answers["openai-codex"] = () =>
			new Promise<LocalBackendResponse>((resolve) => {
				answer = resolve;
			});
		const { props } = renderSelector(
			{ profileId: "auto", phaseModels: BALANCED_PHASE_MODELS },
			"openai-codex",
		);
		await waitFor(() => expect(localBackendRequest).toHaveBeenCalled());
		expect(props.onPhaseModelsChange).not.toHaveBeenCalled();

		answer(
			await json({
				provider: "openai-codex",
				source: "live",
				fetchedAt: 1,
				error: null,
				models: [
					{ value: "gpt-5.5", label: "GPT-5.5", tier: "flagship" },
					{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "standard" },
				],
			}),
		);
		await waitFor(() =>
			expect(props.onPhaseModelsChange).toHaveBeenCalledWith({
				spec: "gpt-5.6-terra",
				planning: "gpt-5.6-terra",
				coding: "gpt-5.6-terra",
				qa: "gpt-5.6-terra",
			}),
		);
		expect(
			screen.getByText("Uses GPT-5.5 across all phases with optimized thinking levels"),
		).toBeInTheDocument();
	});

	it("keeps the saved models when the provider offers no model at all", async () => {
		const { props } = renderSelector(
			{ profileId: "custom", model: "opus", phaseModels: BALANCED_PHASE_MODELS },
			"acme-llm",
		);
		await waitFor(() => expect(localBackendRequest).toHaveBeenCalled());
		await screen.findByRole("combobox", { name: "Model" });
		expect(props.onPhaseModelsChange).not.toHaveBeenCalled();
		expect(props.onModelChange).not.toHaveBeenCalled();
	});

	it("names a preset's model as the provider would when it has no catalog", async () => {
		renderSelector({ provider: "acme-llm" });
		fireEvent.keyDown(screen.getByRole("combobox", { name: "Agent Profile" }), { key: "Enter" });
		expect(await screen.findByRole("option", { name: /Quick Edits/ })).toHaveTextContent(
			"(haiku + Low)",
		);
	});
});
