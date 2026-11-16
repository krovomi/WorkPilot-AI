/**
 * The add-agent dialog offers a manual agent or a whole suggested crew; a
 * crew is created one agent per role, in its order, then the dialog closes.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MissionControlPlannedAgent } from "../../../../shared/types/mission-control";
import { useMissionControlStore } from "../../../stores/mission-control-store";

vi.mock("../../../hooks/useProviderModelCatalog", () => ({
	useProviderModelCatalog: () => ({ models: [] }),
}));

const crew = [
	{ key: "debugger-1", role: "debugger", provider: "openai", model: "m1", model_label: "M1" },
	{ key: "coder-2", role: "coder", provider: "pi", model: "", model_label: "" },
] as MissionControlPlannedAgent[];

vi.mock("../AutoComposePanel", () => ({
	AutoComposePanel: (props: {
		defaultProvider: string;
		onApply: (agents: MissionControlPlannedAgent[]) => Promise<void>;
	}) => (
		<button type="button" onClick={() => void props.onApply(crew)}>
			{props.defaultProvider}
		</button>
	),
}));

import { AddAgentDialog } from "../AddAgentDialog";

afterEach(cleanup);

it("creates the suggested crew from the Auto-compose tab and closes", async () => {
	const createAgent = vi.fn().mockResolvedValue(null);
	useMissionControlStore.setState({ createAgent });
	const onOpenChange = vi.fn();
	render(<AddAgentDialog open onOpenChange={onOpenChange} onAdd={vi.fn()} />);

	expect(screen.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
	expect(screen.getByText("Agent Name").closest(".hidden")).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "Auto-compose" }));
	// Hidden, not unmounted: the manual form keeps what was typed.
	expect(screen.getByText("Agent Name").closest(".hidden")).not.toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "anthropic" }));
	await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	expect(createAgent.mock.calls).toEqual([
		["Debugger 1", "debugger", "openai", "m1", "M1"],
		["Coder 2", "coder", "pi", "", ""],
	]);
});
