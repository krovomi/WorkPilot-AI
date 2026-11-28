/**
 * The add-agent dialog offers a manual agent or a whole suggested crew; a
 * crew is created one agent per role, in its order, then the dialog closes.
 * A refused agent stops the crew and keeps the dialog open.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MissionControlPlannedAgent } from "../../../../shared/types/mission-control";
import { useMissionControlStore } from "../../../stores/mission-control-store";

vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({ models: [] }),
}));

const crew = [
	{
		key: "debugger-1",
		role: "debugger",
		provider: "openai",
		model: "m1",
		model_label: "M1",
		input_tokens: 900,
		output_tokens: 100,
	},
	{ key: "coder-2", role: "coder", provider: "pi", model: "", model_label: "", input_tokens: 0, output_tokens: 0 },
] as MissionControlPlannedAgent[];
const plan = { providers: ["openai", "pi"], budgetUsd: 2 };

vi.mock("../AutoComposePanel", () => ({
	AutoComposePanel: (props: {
		defaultProvider: string;
		onApply: (agents: MissionControlPlannedAgent[], p: typeof plan) => Promise<void>;
	}) => (
		<button type="button" onClick={() => void props.onApply(crew, plan)}>
			{props.defaultProvider}
		</button>
	),
}));

import { AddAgentDialog } from "../AddAgentDialog";

afterEach(cleanup);

it("creates the suggested crew from the Auto-compose tab and closes", async () => {
	const createAgent = vi.fn().mockResolvedValue({ id: "agent" });
	const setPlan = vi.fn().mockResolvedValue(true);
	useMissionControlStore.setState({ createAgent, setPlan });
	const onOpenChange = vi.fn();
	render(<AddAgentDialog open onOpenChange={onOpenChange} onAdd={vi.fn()} />);

	expect(screen.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
	expect(screen.getByText("Agent Name").closest(".hidden")).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "Auto-compose" }));
	// Hidden, not unmounted: the manual form keeps what was typed.
	expect(screen.getByText("Agent Name").closest(".hidden")).not.toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "anthropic" }));
	await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	// The plan first, so a stuck agent of the crew knows where it may go.
	expect(setPlan).toHaveBeenCalledWith(plan);
	expect(createAgent.mock.calls).toEqual([
		["Debugger 1", "debugger", "openai", "m1", "M1", { origin: "auto", estimatedTokens: 1000 }],
		["Coder 2", "coder", "pi", "", "", { origin: "auto", estimatedTokens: 0 }],
	]);
});

it("stops the crew at the first refused agent and stays open", async () => {
	const createAgent = vi.fn().mockResolvedValue(null);
	useMissionControlStore.setState({ createAgent, setPlan: vi.fn().mockResolvedValue(false) });
	const onOpenChange = vi.fn();
	render(<AddAgentDialog open onOpenChange={onOpenChange} onAdd={vi.fn()} />);

	fireEvent.click(screen.getByRole("tab", { name: "Auto-compose" }));
	fireEvent.click(screen.getByRole("button", { name: "anthropic" }));
	await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
	expect(createAgent).toHaveBeenCalledWith("Debugger 1", "debugger", "openai", "m1", "M1", {
		origin: "auto",
		estimatedTokens: 1000,
	});
	expect(onOpenChange).not.toHaveBeenCalled();
});
